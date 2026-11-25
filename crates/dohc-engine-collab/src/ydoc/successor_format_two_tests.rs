use super::*;

const WRITTEN_NOTES: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence.json");
const LINKS: &str =
    "# Title\n\nSee [a link](https://example.com).\n\nAnd [another](https://example.org \"Its title\").\n";
const KEPT_FRONTMATTER: &str = "---\n# kept\ntitle: A\ntags: b\nstatus: c\nowner: d\n---\n\nBody\n";

const HASHES: [&str; 3] = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

fn identity_input<'a>(
    key: &'a crate::DocKey,
    result_sha256: &'a str,
) -> SuccessorIdentityInput<'a> {
    SuccessorIdentityInput {
        key,
        predecessor_claim_id: HASHES[0],
        predecessor_state_vector_sha256: HASHES[1],
        artifact_op_kind: "conflict.resolve",
        artifact_id: "conflict",
        artifact_preimage_sha256: HASHES[2],
        content_kind: ContentKind::Richdoc,
        result_sha256,
    }
}

fn identity(artifact: &str, schema_version: u8) -> SuccessorIdentity {
    let key = crate::DocKey::new("workspace", "main", "object").unwrap();
    let result = crate::hex_sha256(artifact.as_bytes());
    SuccessorIdentity::derive_with_schema_version(identity_input(&key, &result), schema_version)
}

fn successor(artifact: &str) -> SuccessorBase {
    fresh_successor_base(&identity(artifact, 2), artifact).expect("successor")
}

struct Loaded {
    schema_version: u8,
    body_items: bool,
    sequence_length: u32,
    file: String,
}

fn loaded(base: &SuccessorBase) -> Loaded {
    let doc = Ydoc::wire();
    doc.apply(&base.update).expect("successor update");
    let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let txn = doc.doc.transact();
    let (body_items, sequence_length) = (body.len(&txn) > 0, sequence.len(&txn));
    drop(txn);
    let projection = doc
        .project(ContentKind::Richdoc)
        .expect("projection")
        .content;
    Loaded {
        schema_version: doc.note_schema_version(),
        body_items,
        sequence_length,
        file: doc
            .preserved_markdown_source(&projection)
            .unwrap_or(projection),
    }
}

#[test]
fn a_successor_of_a_format_two_note_is_one_sequence_that_projects_its_artifact() {
    let artifact = "# Title\n\nOne **bold** line\n\n- a\n- b\n\n> quoted\n";
    reading_body_sequence_here(|| {
        let base = successor(artifact);
        let note = loaded(&base);
        assert_eq!(note.schema_version, 2);
        assert!(!note.body_items);
        assert!(note.sequence_length > 0);
        assert_eq!(note.file, artifact);
        assert_eq!(base, successor(artifact));
    });
}

#[test]
fn the_format_two_version_is_part_of_the_epoch_and_any_other_version_is_format_one() {
    let artifact = "text\n";
    let key = crate::DocKey::new("workspace", "main", "object").unwrap();
    let derived = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &"a".repeat(64),
        predecessor_state_vector_sha256: &"b".repeat(64),
        artifact_op_kind: "conflict.resolve",
        artifact_id: "conflict",
        artifact_preimage_sha256: &"c".repeat(64),
        content_kind: ContentKind::Richdoc,
        result_sha256: &crate::hex_sha256(artifact.as_bytes()),
    });
    assert_eq!(derived, identity(artifact, 1));
    assert_eq!(derived, identity(artifact, 7));
    assert_ne!(identity(artifact, 2).epoch_tag, derived.epoch_tag);
    assert_ne!(identity(artifact, 2).client_id, derived.client_id);
    let result = crate::hex_sha256(artifact.as_bytes());
    let plain = |schema_version| {
        SuccessorIdentity::derive_with_schema_version(
            SuccessorIdentityInput {
                content_kind: ContentKind::Plaintext,
                ..identity_input(&key, &result)
            },
            schema_version,
        )
    };
    assert_eq!(plain(2), plain(1));
}

#[test]
fn a_successor_with_a_container_that_holds_no_line_is_written_in_format_one() {
    reading_body_sequence_here(|| {
        for artifact in [">\n", "hello\n\n>\n"] {
            let note = loaded(&successor(artifact));
            assert_eq!(note.schema_version, 1, "{artifact:?}");
            assert_eq!(note.file, artifact);
        }
    });
}

#[test]
fn an_engine_that_does_not_read_format_two_refuses_to_write_its_successor() {
    let error = fresh_successor_base(&identity("text\n", 2), "text\n").expect_err("refused");
    assert!(matches!(
        error,
        CollabError::InvalidSuccessorBase {
            constraint: "format-2 successor",
            ..
        }
    ));
}

#[test]
fn a_successor_format_two_cannot_hold_is_written_in_format_one() {
    let linked_code = "Run [`npm install`](https://example.com) first\n";
    let many_lines = format!("{}a\n", "a\n\n".repeat(26_000));
    reading_body_sequence_here(|| {
        for artifact in [linked_code, many_lines.as_str()] {
            let note = loaded(&successor(artifact));
            assert_eq!(note.schema_version, 1);
            assert_eq!(note.sequence_length, 0);
            assert_eq!(note.file, artifact);
        }
        assert_eq!(successor(linked_code), successor(linked_code));
    });
}

#[test]
fn a_successor_keeps_room_for_a_kept_source_under_the_struct_limit() {
    let note = |paragraphs: usize, headings: usize, end: &str| {
        format!(
            "{}{}{end}",
            "a\n\n".repeat(paragraphs),
            vec!["# a"; headings].join("\n\n")
        )
    };
    reading_body_sequence_here(|| {
        for (paragraphs, headings, end, structs, schema_version) in [
            (24_996, 2, "\n", 99_999, 2),
            (24_995, 3, "\n", 100_000, 2),
            (24_994, 4, "\n", 100_001, 1),
            (24_997, 2, "\n", 100_003, 1),
            (24_995, 3, "\n\n", 100_000, 2),
        ] {
            let artifact = note(paragraphs, headings, end);
            let note = loaded(&successor(&artifact));
            assert_eq!(note.schema_version, schema_version, "{structs} structs");
            assert_eq!(note.file, artifact, "{structs} structs");
        }
    });
}

#[test]
fn a_successor_of_a_note_with_links_gives_the_same_bytes_each_time() {
    reading_body_sequence_here(|| {
        let first = successor(LINKS);
        assert_eq!(loaded(&first).schema_version, 2);
        for _ in 1..20 {
            assert_eq!(successor(LINKS).update, first.update);
        }
    });
}

#[test]
fn a_successor_of_a_note_with_kept_frontmatter_gives_the_same_bytes_each_time() {
    reading_body_sequence_here(|| {
        let first = successor(KEPT_FRONTMATTER);
        for _ in 1..20 {
            assert_eq!(successor(KEPT_FRONTMATTER).update, first.update);
        }
    });
}

#[test]
fn only_a_successor_writes_a_note_in_format_two() {
    reading_body_sequence_here(|| {
        let doc = Ydoc::wire();
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        meta.insert(
            &mut doc.doc.transact_mut(),
            "schemaVersion",
            Any::Number(2.0),
        );
        assert!(doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "# a\n")
            .is_err());
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        assert_eq!(sequence.len(&doc.doc.transact()), 0);
    });
}

#[test]
fn a_successor_of_an_empty_artifact_or_kept_source_stays_in_format_two() {
    reading_body_sequence_here(|| {
        let empty = loaded(&successor(""));
        assert_eq!(
            (
                empty.schema_version,
                empty.sequence_length,
                empty.file.as_str()
            ),
            (2, 0, "")
        );
        let kept = loaded(&successor("* a\n* b\n"));
        assert_eq!(kept.schema_version, 2);
        assert!(kept.sequence_length > 0);
        assert_eq!(kept.file, "* a\n* b\n");
    });
}

#[test]
fn each_shared_note_a_successor_takes_gives_the_pinned_bytes() {
    #[derive(serde::Deserialize)]
    struct Note {
        name: String,
        markdown: Option<String>,
    }
    use serde::Deserialize as _;
    let mut json = serde_json::Deserializer::from_str(WRITTEN_NOTES);
    json.disable_recursion_limit();
    let notes = Vec::<Note>::deserialize(&mut json).unwrap();
    let markdown: Vec<(&str, &str)> = notes
        .iter()
        .filter_map(|note| Some((note.name.as_str(), note.markdown.as_deref()?)))
        .chain([
            ("a plain link and a titled link", LINKS),
            ("frontmatter with a comment", KEPT_FRONTMATTER),
        ])
        .collect();
    let (mut updates, mut not_format_two) = (Vec::new(), Vec::new());
    reading_body_sequence_here(|| {
        for (name, markdown) in &markdown {
            let build = || fresh_successor_base(&identity(markdown, 2), markdown);
            let Ok(first) = build() else {
                not_format_two.push(format!("refused: {name}"));
                continue;
            };
            for _ in 1..50 {
                assert_eq!(build().unwrap().update, first.update, "{name}");
            }
            if loaded(&first).schema_version != 2 {
                not_format_two.push(format!("format 1: {name}"));
            }
            updates.extend(first.update);
        }
    });
    assert_eq!(markdown.len(), 24);
    assert_eq!(
        (crate::hex_sha256(&updates), not_format_two),
        (
            "faf7965808e85b95f8cf1868ffc372e5c6f72c5679cb9c4b64568fff9d91d2af".to_owned(),
            [
                "lists, a to-do, a callout and an uneven table",
                "values and paths a reader must repair",
                "what a listItem holds",
                "what a taskItem holds",
                "every path a reader repairs, and which lines share a container",
                "what a block cannot hold goes to a paragraph after it",
            ]
            .map(|name| format!("refused: {name}"))
            .to_vec()
        )
    );
}
