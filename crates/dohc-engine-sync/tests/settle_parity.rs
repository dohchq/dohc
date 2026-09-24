//! The relay derives a shared document's current Markdown with the engine's
//! `ydoc.project` method, which returns `project_ydoc_updates`: the stored
//! updates applied to an empty document and projected by
//! `project_ydoc_with_store`, the function both the editor settle and remote
//! apply write from. These vectors pin that output, so a change to what an
//! owner device settles shows up here as a changed file.
//!
//! `settle-parity/yjs.json` is written by the TypeScript test from Yjs updates
//! the desktop produces, with Markdown from the engine method.
//! `settle-parity/yrs.json` is written here from updates the engine produces.
//! This test and the TypeScript test, which runs the engine binary, assert
//! both files. Regenerate with `DOHC_WRITE_SETTLE_PARITY_VECTORS=1`.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_collab::{
    ContentKind, DocKey, SuccessorIdentity, SuccessorIdentityInput, Ydoc, fresh_successor_base,
};
use dohc_engine_sync::project_ydoc_updates;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize, Serialize)]
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

fn read(name: &str) -> Vec<Vector> {
    serde_json::from_slice(&std::fs::read(fixture(name)).expect("read vectors"))
        .expect("parse vectors")
}

fn key() -> DocKey {
    DocKey::new("workspace", "main", "object").expect("key")
}

fn settle(updates: &[Vec<u8>]) -> String {
    project_ydoc_updates(updates.iter().map(Vec::as_slice), ContentKind::Richdoc)
        .expect("settle projection")
        .content
}

const RICH: &str = "# Plan\n\nSome **bold**, _italic_, `code`, ~~gone~~ and a [link](https://example.com \"Title\").\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [ ] open task\n- [x] done task\n\n> quoted\n\n> [!note] Callout title\n> Callout body\n\n```ts\nconst value = 1\n```\n\n| Left | Right |\n| :--- | ---: |\n| a | b |\n\n$$\nx^2\n$$\n\nInline $y$ math, a [[Wiki Page|label]] and ![alt](image.png).\n\n---\n\nTail 🦀 世界.\n";

const RESOLVED: &str = "# Resolved\n\nChosen text with **bold**, a [link](https://example.com), and a list:\n\n- one\n- two\n";

// YAML scalars that js-yaml and the engine's loader read differently. The
// TypeScript test seeds the same files the way the desktop opens them.
const YAML_NON_FINITE: &str = "---\nnan: .nan\ninf: .inf\nneg: -.inf\n---\n\nBody\n";
const YAML_BEYOND_I64: &str =
    "---\nbig: 9223372036854775808\nsmall: -9223372036854775809\n---\n\nBody\n";
const YAML_NEGATIVE_ZERO: &str = "---\nzero: -0\nfloat: -0.0\n---\n\nBody\n";
const YAML_EXPLICIT_INT: &str = "---\ntagged: !!int 7\noctal: !!int 0o7\n---\n\nBody\n";
const YAML_SEPARATED_RADIX: &str = "---\nhex: 0x_1F\nbin: 0b1010_1010\nsep: 1_000\n---\n\nBody\n";

const TABLE: &str =
    "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n**bold** _italic_ `code`";

struct Lineage {
    doc: Ydoc,
    updates: Vec<Vec<u8>>,
}

impl Lineage {
    fn imported(markdown: &str) -> Self {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
            .expect("import");
        let updates = vec![doc.encode_full_state()];
        Self { doc, updates }
    }

    fn edit(mut self, edit: impl FnOnce(&Ydoc) -> Vec<u8>) -> Self {
        let update = edit(&self.doc);
        self.updates.push(update);
        self
    }

    fn vector(self, name: &str) -> Vector {
        Vector {
            name: name.to_owned(),
            markdown: settle(&self.updates),
            updates: self
                .updates
                .iter()
                .map(|update| STANDARD.encode(update))
                .collect(),
        }
    }
}

fn successor(artifact: &str) -> Lineage {
    let key = key();
    let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &"a".repeat(64),
        predecessor_state_vector_sha256: &"b".repeat(64),
        artifact_op_kind: "conflict.resolve",
        artifact_id: "resolution",
        artifact_preimage_sha256: &"c".repeat(64),
        content_kind: ContentKind::Richdoc,
        result_sha256: &dohc_engine_storage::hex_sha256(artifact.as_bytes()),
    });
    let base = fresh_successor_base(&identity, artifact).expect("successor base");
    let doc = Ydoc::wire();
    doc.apply(&base.update).expect("apply successor");
    Lineage {
        doc,
        updates: vec![base.update],
    }
}

fn yrs_vectors() -> Vec<Vector> {
    let canonical = |markdown: &str| {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
            .expect("import");
        doc.project(ContentKind::Richdoc).expect("project").content
    };
    vec![
        Lineage::imported(RICH).vector("import-rich"),
        Lineage::imported("---\ntitle: Plan\nnested:\n  z: last\n  a: first\n---\n\nBody\n")
            .vector("import-frontmatter"),
        Lineage::imported("# Title\r\n\r\nFirst\r\n\r\nSecond\r\n").vector("import-crlf"),
        Lineage::imported("---\npriority: !custom high\n---\n\nBody\n")
            .vector("import-tagged"),
        Lineage::imported(RICH)
            .edit(|doc| doc.richdoc_append_paragraph("Appended by the engine"))
            .edit(|doc| doc.frontmatter_set("status", "done"))
            .vector("import-then-edit"),
        Lineage::imported(TABLE)
            .edit(|doc| {
                doc.frontmatter_set_preserving_markdown_source(
                    "id",
                    "01j00000000000000000000000",
                    &format!("---\nid: 01j00000000000000000000000\n---\n\n{TABLE}"),
                )
                .expect("adopt")
            })
            .vector("adoption-preserves-source"),
        Lineage::imported(TABLE)
            .edit(|doc| {
                doc.frontmatter_set_preserving_markdown_source(
                    "id",
                    "01j00000000000000000000000",
                    &format!("---\nid: 01j00000000000000000000000\n---\n\n{TABLE}"),
                )
                .expect("adopt")
            })
            .edit(|doc| doc.frontmatter_set("status", "later edit"))
            .vector("adoption-then-edit"),
        Lineage::imported("Plain start")
            .edit(|doc| {
                doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    "Some *emphasis* and __strong__ text.\n",
                )
                .expect("rewrite")
            })
            .vector("rewrite-preserves-source"),
        Lineage::imported("Plain start")
            .edit(|doc| {
                doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    "---\ntitle:   Spaced\n---\n\n\n# Heading\n\n- one\n- two\n\n\n```rs\nfn main() {}\n```\n",
                )
                .expect("rewrite")
            })
            .vector("rewrite-preserves-block-spacing"),
        Lineage::imported("Plain start")
            .edit(|doc| {
                doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    "<!-- dohc:table row-heights=1:84 -->\n| a | b |\n| :-- | --: |\n| c | d |\n",
                )
                .expect("rewrite")
            })
            .vector("rewrite-annotated-table"),
        Lineage::imported("> quote\n>\n> > nested\n\n3. three\n4. four\n")
            .vector("import-quotes-and-ordinals"),
        Lineage::imported(YAML_NON_FINITE).vector("import-yaml-non-finite"),
        Lineage::imported(YAML_BEYOND_I64).vector("import-yaml-beyond-i64"),
        Lineage::imported(YAML_NEGATIVE_ZERO).vector("import-yaml-negative-zero"),
        Lineage::imported(YAML_EXPLICIT_INT).vector("import-yaml-explicit-int"),
        Lineage::imported(YAML_SEPARATED_RADIX).vector("import-yaml-separated-radix"),
        Lineage::imported("Plain start")
            .edit(|doc| {
                doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    "---\na: .nan\n---\n\nBody\n",
                )
                .expect("rewrite")
            })
            .vector("rewrite-yaml-nan"),
        Lineage::imported("Plain start")
            .edit(|doc| {
                doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    "---\na: !!int 0o7\n---\n\nBody\n",
                )
                .expect("rewrite")
            })
            .vector("rewrite-yaml-explicit-octal"),
        successor(&canonical(RESOLVED)).vector("successor-base"),
        successor(&canonical(RESOLVED))
            .edit(|doc| doc.richdoc_append_paragraph("After the resolution"))
            .vector("successor-then-edit"),
    ]
}

fn decode(vector: &Vector) -> Vec<Vec<u8>> {
    vector
        .updates
        .iter()
        .map(|update| STANDARD.decode(update).expect("base64 update"))
        .collect()
}

#[test]
fn engine_settle_writes_the_markdown_of_every_vector() {
    let mut mismatches = Vec::new();
    for file in ["yjs.json", "yrs.json"] {
        let vectors = read(file);
        assert!(!vectors.is_empty(), "{file} holds no vectors");
        for vector in vectors {
            let settled = settle(&decode(&vector));
            if settled != vector.markdown {
                mismatches.push(format!(
                    "{file} {}: settled={settled:?}; expected={:?}",
                    vector.name, vector.markdown
                ));
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn engine_vectors_regenerate_with_the_same_markdown() {
    let fresh = yrs_vectors();
    if std::env::var("DOHC_WRITE_SETTLE_PARITY_VECTORS").as_deref() == Ok("1") {
        let rows: Vec<String> = fresh
            .iter()
            .map(|vector| serde_json::to_string(vector).expect("serialize vector"))
            .collect();
        std::fs::write(fixture("yrs.json"), format!("[\n{}\n]\n", rows.join(",\n")))
            .expect("write vectors");
    }
    let committed = read("yrs.json");
    let names = |vectors: &[Vector]| vectors.iter().map(|v| v.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&fresh), names(&committed));
    for (fresh, committed) in fresh.iter().zip(&committed) {
        assert_eq!(fresh.markdown, committed.markdown, "{}", fresh.name);
    }
}
