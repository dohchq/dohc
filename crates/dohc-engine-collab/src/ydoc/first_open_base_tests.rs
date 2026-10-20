//! Fixtures the relay's first-open base construction is pinned against. Set
//! `DOHC_WRITE_FIRST_OPEN_FIXTURES=1` to rewrite the Rust-owned files.
use super::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/first-open-base")
        .join(name)
}

fn writing() -> bool {
    std::env::var("DOHC_WRITE_FIRST_OPEN_FIXTURES").as_deref() == Ok("1")
}

fn read<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    serde_json::from_slice(&std::fs::read(fixture(name)).unwrap()).unwrap()
}

fn write<T: Serialize>(name: &str, rows: &[T]) {
    let lines: Vec<String> = rows
        .iter()
        .map(|row| serde_json::to_string(row).unwrap())
        .collect();
    std::fs::write(fixture(name), format!("[\n{}\n]\n", lines.join(",\n"))).unwrap();
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeedClientFixture {
    workspace_id: String,
    version_id: String,
    object_id: String,
    content_kind: String,
    head_moment_id: String,
    head_blob_sha256: String,
    client_id: u32,
}

#[test]
fn seed_client_ids_match_the_shared_fixture() {
    let long_object = "o".repeat(300);
    let cases = [
        (
            "workspace",
            "main",
            "object",
            ContentKind::Richdoc,
            "moment-1",
            "# Notes\n",
        ),
        (
            "工作区-ü",
            "main",
            "objét-🎉",
            ContentKind::Richdoc,
            "moment-ü",
            "Café\n",
        ),
        (
            "workspace",
            "main",
            "object",
            ContentKind::Plaintext,
            "moment-1",
            "# Notes\n",
        ),
        (
            "workspace",
            "draft-✓",
            "object",
            ContentKind::Scene,
            "",
            "{}",
        ),
        (
            "w",
            "main",
            long_object.as_str(),
            ContentKind::Richdoc,
            "moment-long",
            "",
        ),
        (
            "ws",
            "main",
            "obj",
            ContentKind::Richdoc,
            "moment-2",
            "naïve 中文\n",
        ),
        (
            "ws",
            "main",
            "obj",
            ContentKind::Richdoc,
            "moment-3",
            "naïve 中文\n",
        ),
        (
            "ws-2",
            "main",
            "obj",
            ContentKind::Richdoc,
            "moment-3",
            "naïve 中文\n",
        ),
    ];
    let actual: Vec<SeedClientFixture> = cases
        .iter()
        .map(|(workspace, version, object, kind, moment, text)| {
            let key = crate::DocKey::new(*workspace, *version, *object).unwrap();
            let head = crate::hex_sha256(text.as_bytes());
            SeedClientFixture {
                workspace_id: key.workspace_id.clone(),
                version_id: key.version_id.clone(),
                object_id: key.object_id.clone(),
                content_kind: kind.as_str().to_owned(),
                head_moment_id: (*moment).to_owned(),
                client_id: seed_client_id(&key, *kind, moment, &head),
                head_blob_sha256: head,
            }
        })
        .collect();
    if writing() {
        write("seed-client-ids.json", &actual);
    }
    assert_eq!(
        read::<Vec<SeedClientFixture>>("seed-client-ids.json"),
        actual
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TsBase {
    name: String,
    markdown: String,
    canonical: String,
    #[allow(dead_code)]
    client_id: u32,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct YrsBase {
    name: String,
    bytes: Vec<u8>,
}

/// yrs keeps JSON object values in a HashMap, so these bases re-encode in no
/// fixed key order.
const UNORDERED: [&str; 2] = ["links", "frontmatter-nested"];
/// Bases whose witness the TypeScript validator verifies but the engine's
/// reader does not reproduce, so the engine settles the canonical projection.
const ENGINE_SETTLES_CANONICAL: [&str; 1] = ["links"];

/// The file text, canonical projection, and state vector a base decodes to.
fn settled(bytes: &[u8], markdown: &str) -> (String, String, Vec<u8>) {
    let doc = Ydoc::wire();
    doc.apply(bytes).unwrap();
    assert!(!doc.has_pending_dependencies());
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    let file = doc
        .settled_markdown_source(&projection, || {
            Ok::<_, CollabError>(Some(markdown.to_owned()))
        })
        .unwrap()
        .unwrap_or_else(|| projection.clone());
    (file, projection, doc.encode_state_vector())
}

#[test]
fn first_open_bases_settle_their_file_and_reencode_through_the_full_state() {
    let bases: Vec<TsBase> = read("ts-bases.json");
    assert!(!bases.is_empty());
    let encoded: Vec<YrsBase> = bases
        .iter()
        .map(|base| {
            let (file, projection, _) = settled(&base.bytes, &base.markdown);
            assert_eq!(projection, base.canonical, "{}", base.name);
            let expected = if ENGINE_SETTLES_CANONICAL.contains(&base.name.as_str()) {
                assert_ne!(base.canonical, base.markdown, "{}", base.name);
                &base.canonical
            } else {
                &base.markdown
            };
            assert_eq!(&file, expected, "{}", base.name);
            let doc = Ydoc::wire();
            doc.apply(&base.bytes).unwrap();
            YrsBase {
                name: base.name.clone(),
                bytes: doc.encode_full_state(),
            }
        })
        .collect();
    if writing() {
        write("yrs-bases.json", &encoded);
    }
    let committed: Vec<YrsBase> = read("yrs-bases.json");
    assert_eq!(committed.len(), bases.len());
    for ((base, fresh), kept) in bases.iter().zip(&encoded).zip(&committed) {
        assert_eq!(kept.name, base.name);
        if UNORDERED.contains(&base.name.as_str()) {
            assert_eq!(
                settled(&kept.bytes, &base.markdown),
                settled(&fresh.bytes, &base.markdown),
                "{}",
                base.name
            );
        } else {
            assert_eq!(kept.bytes, fresh.bytes, "{}", base.name);
        }
    }
}
