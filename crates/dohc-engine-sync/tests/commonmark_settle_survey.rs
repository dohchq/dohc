//! Measure desktop-built CommonMark vectors through the owner's settlement projector.
//! Generate vectors with packages/ydoc-projection/scripts/generate-commonmark-settle-survey.mjs.
//! Set DOHC_COMMONMARK_VECTORS and DOHC_COMMONMARK_RESULTS to external evidence paths.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
use dohc_engine_sync::{SyncError, project_ydoc_with_store};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{BufWriter, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    example: usize,
    section: String,
    source: String,
    source_sha256: String,
    canonical: String,
    updates: Vec<String>,
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn store(source: Option<&str>) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE snapshots (workspace_id TEXT, version_id TEXT, object_id TEXT, content_kind TEXT, blob_sha256 TEXT); CREATE TABLE blobs (sha256 TEXT, text TEXT);").unwrap();
    if let Some(source) = source {
        let digest = sha(source.as_bytes());
        db.execute("INSERT INTO blobs VALUES (?1, ?2)", params![digest, source])
            .unwrap();
        db.execute(
            "INSERT INTO snapshots VALUES ('workspace', 'main', 'object', 'text', ?1)",
            [digest],
        )
        .unwrap();
    }
    db
}

fn settle(doc: &Ydoc, source: Option<&str>, original: &str) -> Value {
    let key = DocKey::new("workspace", "main", "object").unwrap();
    match project_ydoc_with_store(&store(source), &key, doc, ContentKind::Richdoc) {
        Ok(projection) => json!({
            "status": if projection.content.as_bytes() == original.as_bytes() { "kept" } else { "rewritten" },
            "settled": projection.content,
            "settledSha256": sha(projection.content.as_bytes()),
            "destructive": projection.destructive,
        }),
        Err(error) => {
            let status = match &error {
                SyncError::MarkdownReaderPending(_) | SyncError::RetryableState { .. } => "held",
                SyncError::InvalidInput { .. }
                | SyncError::InputTooLarge { .. }
                | SyncError::ProjectionTooLarge { .. } => "refused",
                _ => "error",
            };
            json!({"status": status, "error": format!("{error:?}")})
        }
    }
}

#[test]
#[ignore = "external CommonMark survey; enable after the issue owner selects regression expectations"]
fn commonmark_desktop_documents_settle() {
    let input = std::env::var_os("DOHC_COMMONMARK_VECTORS").expect("set DOHC_COMMONMARK_VECTORS");
    let output = std::env::var_os("DOHC_COMMONMARK_RESULTS").expect("set DOHC_COMMONMARK_RESULTS");
    assert_ne!(std::path::Path::new(&input), std::path::Path::new(&output));
    let vectors: Vec<Vector> = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    assert!(!vectors.is_empty());
    let mut seen = BTreeSet::new();
    let mut writer = BufWriter::new(std::fs::File::create(output).unwrap());
    let mut errors = 0;
    for vector in vectors {
        assert!(seen.insert(vector.example), "duplicate example");
        assert_eq!(sha(vector.source.as_bytes()), vector.source_sha256);
        assert!(!vector.updates.is_empty());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let doc = Ydoc::wire();
            for update in &vector.updates {
                let bytes = STANDARD.decode(update).map_err(|error| error.to_string())?;
                doc.apply(&bytes).map_err(|error| format!("{error:?}"))?;
            }
            if doc.has_pending_dependencies() {
                return Err("incomplete vector: missing Y.Doc dependencies".to_owned());
            }
            let canonical = doc.project(ContentKind::Richdoc).map(|p| p.content);
            Ok::<_, String>(json!({
                "withSnapshot": settle(&doc, Some(&vector.source), &vector.source),
                "withoutSnapshot": settle(&doc, None, &vector.source),
                "nativeCanonical": canonical.as_ref().ok(),
                "nativeCanonicalError": canonical.as_ref().err().map(|error| format!("{error:?}")),
                "nativeWitnessKept": canonical.as_ref().ok().is_some_and(|canonical|
                    doc.preserved_markdown_source(canonical).as_deref() == Some(vector.source.as_str())),
            }))
        }));
        let details = match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => json!({"withSnapshot": {"status": "error", "error": error}}),
            Err(_) => json!({"withSnapshot": {"status": "error", "error": "native panic"}}),
        };
        if details["withSnapshot"]["status"] == "error"
            || details["withoutSnapshot"]["status"] == "error"
        {
            errors += 1;
        }
        let row = json!({"example": vector.example, "section": vector.section,
            "source": vector.source, "sourceSha256": vector.source_sha256,
            "desktopCanonical": vector.canonical, "result": details});
        serde_json::to_writer(&mut writer, &row).unwrap();
        writeln!(writer).unwrap();
    }
    writer.flush().unwrap();
    assert_eq!(errors, 0, "survey errors; inspect per-example results");
}
