//! Native parity with owner settlement without a file snapshot.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
use dohc_engine_sync::{UpdateProjectionError, project_ydoc_updates, project_ydoc_with_store};
use rusqlite::Connection;
use serde::Deserialize;
use std::path::PathBuf;
#[derive(Deserialize)]
struct Vector {
    name: String,
    updates: Vec<String>,
    markdown: String,
}
fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/settle-parity")
        .join(name)
}
fn decode(vector: &Vector) -> Vec<Vec<u8>> {
    vector
        .updates
        .iter()
        .map(|u| STANDARD.decode(u).unwrap())
        .collect()
}
fn store() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE snapshots (workspace_id TEXT, version_id TEXT, object_id TEXT, content_kind TEXT, blob_sha256 TEXT); CREATE TABLE blobs (sha256 TEXT, text TEXT);").unwrap();
    db
}
fn key() -> DocKey {
    DocKey::new("workspace", "main", "object").unwrap()
}
fn assert_owner_parity(updates: &[Vec<u8>], label: &str) -> String {
    let doc = Ydoc::wire();
    for update in updates {
        doc.apply(update).unwrap();
    }
    let owner = project_ydoc_with_store(&store(), &key(), &doc, ContentKind::Richdoc).unwrap();
    let relay = project_ydoc_updates(updates.iter().map(Vec::as_slice), ContentKind::Richdoc)
        .unwrap_or_else(|error| panic!("{label}: {error:?}"));
    assert_eq!(relay, owner);
    relay.content
}
#[test]
fn every_retained_vector_matches_current_owner_settlement_without_a_snapshot() {
    for file in ["yjs.json", "yrs.json"] {
        let vectors: Vec<Vector> =
            serde_json::from_slice(&std::fs::read(fixture(file)).unwrap()).unwrap();
        for vector in &vectors {
            let current = assert_owner_parity(&decode(vector), &format!("{file}: {}", vector.name));
            assert_eq!(current, vector.markdown, "{} {}", file, vector.name);
        }
    }
}
#[test]
fn nested_list_source_remains_preserved_without_the_owners_snapshot() {
    let source = "---\nid: rec\n---\n\n- parent\n  - nested\n";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        doc.preserved_markdown_source(&canonical),
        Some(source.to_owned())
    );
    assert_eq!(
        doc.settled_markdown_source(&canonical, || Ok::<_, ()>(Some(source.to_owned())))
            .unwrap(),
        Some(source.to_owned())
    );
    assert_eq!(
        assert_owner_parity(&[doc.encode_full_state()], "native nested list"),
        source
    );
}
#[test]
fn forged_source_is_never_projected() {
    let vectors: Vec<Vector> =
        serde_json::from_slice(&std::fs::read(fixture("yjs.json")).unwrap()).unwrap();
    for vector in vectors
        .iter()
        .filter(|v| v.name == "source-forged-active" || v.name == "source-forged-stale")
    {
        let content = assert_owner_parity(&decode(vector), &vector.name);
        assert!(!content.contains("Foreign"));
    }
}
#[test]
fn reader_output_waits_for_an_authoritative_snapshot() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let checkpoint = STANDARD
        .decode(data["checkpoint"].as_str().unwrap())
        .unwrap();
    assert!(matches!(
        project_ydoc_updates([checkpoint.as_slice()], ContentKind::Richdoc),
        Err(UpdateProjectionError::Invalid(
            "Markdown reader output requires an authoritative snapshot"
        ))
    ));
}
#[test]
fn reader_kind_always_requires_context_even_when_native_proof_succeeds() {
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};
    let native = Ydoc::wire();
    native
        .rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "A native paragraph.\n",
        )
        .unwrap();
    let canonical = native.project(ContentKind::Richdoc).unwrap().content;
    assert!(native.preserved_markdown_source(&canonical).is_some());
    let doc = yrs::Doc::new();
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(&native.encode_full_state()).unwrap())
        .unwrap();
    doc.get_or_insert_map("meta")
        .insert(&mut doc.transact_mut(), "dohcMarkdownSourceReader", 1);
    let checkpoint = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    assert!(matches!(
        project_ydoc_updates([checkpoint.as_slice()], ContentKind::Richdoc),
        Err(UpdateProjectionError::Invalid(
            "Markdown reader output requires an authoritative snapshot"
        ))
    ));
}
#[test]
fn output_between_public_and_settlement_caps_is_refused() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Plaintext, &"x".repeat(2 * 1024 * 1024 + 1))
        .unwrap();
    assert!(doc.project(ContentKind::Plaintext).unwrap().content.len() < 16 * 1024 * 1024);
    assert!(matches!(
        project_ydoc_updates([doc.encode_full_state().as_slice()], ContentKind::Plaintext),
        Err(UpdateProjectionError::TooLarge(_))
    ));
}
#[test]
fn incomplete_malformed_and_scene_input_is_refused() {
    for (kind, updates) in [
        (ContentKind::Richdoc, vec![]),
        (ContentKind::Richdoc, vec![vec![255]]),
        (ContentKind::Scene, vec![vec![0, 0]]),
    ] {
        assert!(matches!(
            project_ydoc_updates(updates.iter().map(Vec::as_slice), kind),
            Err(UpdateProjectionError::Invalid(_))
        ));
    }
    let base = Ydoc::wire();
    base.richdoc_append_paragraph("base");
    let delta = base.richdoc_append_paragraph("later");
    assert!(matches!(
        project_ydoc_updates([delta.as_slice()], ContentKind::Richdoc),
        Err(UpdateProjectionError::Invalid(_))
    ));
}
