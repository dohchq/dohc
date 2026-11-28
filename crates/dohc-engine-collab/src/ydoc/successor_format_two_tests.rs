use super::*;

const WRITTEN_NOTES: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence.json");
const FIT: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-fit.json");
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
            assert_eq!(
                loaded(&successor(artifact)).schema_version,
                1,
                "{artifact:?}"
            );
        }
    });
}

#[test]
fn an_engine_that_does_not_read_format_two_refuses_to_write_its_successor() {
    let error = fresh_successor_base(&identity("text\n", 2), "text\n").expect_err("refused");
    assert_eq!(
        error.code(),
        "ydoc-note-uses-a-newer-body-format",
        "{error:?}"
    );
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
            (24_994, 3, "\n", 99_999, 2),
            (24_993, 4, "\n", 100_000, 2),
            (24_992, 5, "\n", 100_001, 1),
            (24_995, 3, "\n", 100_003, 1),
            (24_993, 4, "\n\n", 100_000, 2),
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
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "# a\n")
            .expect("a format-1 rewrite");
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        assert_eq!(sequence.len(&doc.doc.transact()), 0);
        assert_eq!(doc.note_schema_version(), 1);
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
            "08bce415db56696a8d961852a063862979d63746f1837bd7cdd5115d33784926".to_owned(),
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

#[test]
fn a_seed_in_format_two_has_its_own_client_and_format_one_keeps_its_client() {
    let key = crate::DocKey::new("workspace", "main", "object").unwrap();
    let seed = |kind, version| seed_client_id(&key, kind, version, "moment", "blob");
    assert_eq!(seed(ContentKind::Richdoc, 1), 3_076_933_556);
    assert_eq!(seed(ContentKind::Plaintext, 1), 1_708_819_307);
    assert_eq!(seed(ContentKind::Richdoc, 2), 963_707_788);
}

#[test]
fn only_a_rich_document_on_an_engine_that_reads_format_two_is_new_in_format_two() {
    let version = || {
        [
            ContentKind::Richdoc,
            ContentKind::Plaintext,
            ContentKind::Scene,
        ]
        .map(new_note_schema_version)
    };
    assert_eq!(writing_new_notes_in_format_two_here(version), [1, 1, 1]);
    reading_body_sequence_here(|| {
        assert_eq!(version(), [1, 1, 1]);
        assert_eq!(writing_new_notes_in_format_two_here(version), [2, 1, 1]);
    });
}

#[test]
fn a_collection_relation_seed_is_written_in_the_new_note_format() {
    let markdown = "# Title\n\nOne **bold** line\n\n- a\n- b\n";
    let many_lines = format!("{}a\n", "a\n\n".repeat(26_000));
    let seeded = |markdown: &str| {
        let doc = Ydoc::wire();
        doc.seed_collection_relation_markdown(markdown)
            .expect("seed");
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let txn = doc.doc.transact();
        let (body_items, sequence_items) = (body.len(&txn) > 0, sequence.len(&txn) > 0);
        drop(txn);
        let projection = doc.project_richdoc().expect("projection");
        (
            doc.note_schema_version(),
            body_items,
            sequence_items,
            projection == markdown,
        )
    };
    reading_body_sequence_here(|| {
        assert_eq!(seeded(markdown), (1, true, false, true));
        writing_new_notes_in_format_two_here(|| {
            assert_eq!(seeded(markdown), (2, false, true, true));
            assert_eq!(seeded(&many_lines), (1, true, false, true));
        });
    });
}

#[test]
fn a_collection_relation_seed_format_two_cannot_hold_is_written_in_format_one() {
    let linked_code = "Run [`npm install`](https://example.com) first\n";
    reading_body_sequence_here(|| {
        writing_new_notes_in_format_two_here(|| {
            let doc = Ydoc::wire();
            doc.seed_collection_relation_markdown(linked_code)
                .expect("seed");
            let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
            let sequence_length = sequence.len(&doc.doc.transact());
            assert_eq!((doc.note_schema_version(), sequence_length), (1, 0));
            let projection = doc.project_richdoc().expect("projection");
            assert_eq!(
                doc.preserved_markdown_source(&projection)
                    .unwrap_or(projection),
                linked_code
            );
        });
    });
}

#[test]
fn each_recipe_gets_its_typescript_format_and_where_read_alike_at_least_its_index_operations() {
    type Parts = Vec<(usize, String)>;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Note {
        name: String,
        frontmatter: Parts,
        body: Parts,
        index_operations: usize,
        format: u8,
    }
    #[derive(serde::Deserialize)]
    struct Fit {
        notes: Vec<Note>,
    }
    let expand = |parts: &Parts| -> String {
        parts
            .iter()
            .map(|(count, text)| {
                if text.contains("{i}") {
                    (0..*count)
                        .map(|i| text.replace("{i}", &i.to_string()))
                        .collect()
                } else {
                    text.repeat(*count)
                }
            })
            .collect()
    };
    let read_differently = [
        "mark-dense lines at the struct cap",
        "a table of 1,000 cells",
        "20,000 keys in a map and overlapping marks just under the limit",
        "a realistic note near the struct cap",
    ];
    let fit: Fit = serde_json::from_str(FIT).expect("the fit fixture parses");
    assert_eq!(fit.notes.len(), 14);
    let unlike: Vec<String> = reading_body_sequence_here(|| {
        fit.notes
            .iter()
            .filter_map(|note| {
                let markdown = expand(&note.frontmatter) + &expand(&note.body);
                let asked = identity(&markdown, 2);
                let base = match fresh_successor_base(&asked, &markdown) {
                    Ok(base) => base,
                    Err(error) => return Some(format!("{}: {error:?}", note.name)),
                };
                let made = Ydoc::wire();
                made.apply(&base.update).expect("successor update");
                let candidate = match successor_doc(&asked, &markdown, 2.0) {
                    Ok(candidate) => candidate,
                    Err(error) => return Some(format!("{} in format 2: {error:?}", note.name)),
                };
                let weight = candidate.live_note_weight(&markdown);
                let counted = weight.index_operations();
                let refused = base.does_not_fit.map(|over| (over.limit, over.used));
                let expected = (note.format == 1).then_some(("maxIndexOperations", counted));
                let read_alike = !read_differently.contains(&note.name.as_str());
                if !read_alike {
                    eprintln!(
                        "{}: the engine counts {counted}, TypeScript {}",
                        note.name, note.index_operations
                    );
                }
                let alike = made.note_schema_version() == note.format
                    && (!read_alike || counted >= note.index_operations)
                    && refused == expected;
                (!alike).then(|| {
                    let format = made.note_schema_version();
                    format!(
                        "{}: format {format}, {counted} for {}, {refused:?}, {weight:?}",
                        note.name, note.index_operations
                    )
                })
            })
            .collect()
    });
    assert_eq!(unlike, Vec::<String>::new());
}
