use super::body_sequence::tests::{same_document, shown};
use super::*;
use base64::Engine as _;

const FOLDS: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-folds.json");

#[derive(serde::Deserialize)]
struct Fold {
    name: String,
    before: String,
    file: String,
    after: After,
}

#[derive(serde::Deserialize)]
struct After {
    document: serde_json::Value,
    markdown: String,
}

fn note(before: &str) -> Ydoc {
    let doc = Ydoc::wire();
    let update = base64::engine::general_purpose::STANDARD
        .decode(before)
        .expect("base64");
    doc.apply(&update).expect("the note applies");
    doc
}

fn reading(doc: &Ydoc) -> Result<(serde_json::Value, String), CollabError> {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
    let read = {
        let txn = doc.doc.transact();
        body_sequence::blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes)?
    };
    let document = serde_json::json!({ "type": "doc", "content": shown(&read) });
    Ok((document, doc.project(ContentKind::Richdoc)?.content))
}

fn folded(fold: &Fold) -> Result<(serde_json::Value, String), CollabError> {
    let doc = note(&fold.before);
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &fold.file)?;
    reading(&doc)
}

#[test]
fn each_shared_fold_reads_as_its_document_after() {
    let folds: Vec<Fold> = serde_json::from_str(FOLDS).expect("the shared folds");
    let mut differing = Vec::new();
    reading_body_sequence_here(|| {
        for fold in &folds {
            match folded(fold) {
                Ok((document, markdown))
                    if same_document(&fold.after.document, &document)
                        && markdown == fold.after.markdown => {}
                Ok((document, markdown)) => {
                    differing.push(format!("{}: read {document} as {markdown:?}", fold.name))
                }
                Err(error) => differing.push(format!("{}: {error:?}", fold.name)),
            }
        }
    });
    assert_eq!(folds.len(), 27);
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}
