use super::*;
use base64::Engine;

fn successor(source: &str) -> Result<SuccessorBase, CollabError> {
    let key = crate::DocKey::new("workspace", "main", "object").unwrap();
    fresh_successor_base(
        &SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: "claim",
            predecessor_state_vector_sha256: "vector",
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: "preimage",
            content_kind: ContentKind::Richdoc,
            result_sha256: &crate::hex_sha256(source.as_bytes()),
        }),
        source,
    )
}

#[test]
fn nested1b_disagreeing_readings_hold() {
    for source in [
        "- a\n\n- b\n  - c",
        "- p\n  - a\n\n  - b",
        "* parent\n  * a\n\n  * b\n",
        "1. a\n    1. child\n\n2. b\n",
        "- parent\n  - child\n\n| h |\n| --- |\n| v |\n",
    ] {
        assert!(!outside_markdown_is_allowlisted(source), "{source:?}");
        assert!(successor(source).is_err(), "{source:?}");
        assert!(
            Ydoc::wire()
                .seed_collection_relation_markdown(source)
                .is_err(),
            "{source:?}"
        );
    }
}

#[test]
fn nested1b_desktop_block_starts_hold() {
    for source in [
        "- step\n\n  $$\n  x^2\n  $$\n  - sub\n",
        "- $$\n  x^2\n  $$\n  - sub\n",
        "- parent\n\n  <div\n  - child",
        "- parent\n\n  <div \n  - child",
        "- parent\n\n  <pre\n  - child",
    ] {
        assert!(!outside_markdown_is_allowlisted(source), "{source:?}");
        assert!(successor(source).is_err(), "{source:?}");
        assert!(
            Ydoc::wire()
                .seed_collection_relation_markdown(source)
                .is_err(),
            "{source:?}"
        );
    }
}

#[test]
fn nested1b_fence_tracking_cannot_hide_blocks() {
    for source in [
        "- a\n\n  ```\n  code\n  ````\n  <div>\n  ```\n",
        "- a\n\n  ```\n  code\n   ```\n  <div>\n  ```\n",
        "```bad`info\n```\n- a\n  - child\n  <div>\n```\n",
    ] {
        assert!(!outside_markdown_is_allowlisted(source), "{source:?}");
        assert!(successor(source).is_err(), "{source:?}");
        assert!(
            Ydoc::wire()
                .seed_collection_relation_markdown(source)
                .is_err(),
            "{source:?}"
        );
    }
}

#[test]
fn nested1b_flat_successor_keeps_indented_code_but_holds_quote_overflow() {
    for source in ["Text\n\n    code\n", "Install:\n\n    npm i foo"] {
        assert!(successor(source).is_ok(), "{source:?}");
    }
    assert!(successor(&format!("{}deep", "> ".repeat(121))).is_err());
}

#[test]
fn nested1b_frontmatter_repairs_missing_schema_version() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "- parent\n  - child\n")
        .unwrap();
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    meta.remove(&mut doc.doc.transact_mut(), "schemaVersion");
    doc.replace_frontmatter_for_fold("---\nstatus: open\n---\n- parent\n  - child\n")
        .unwrap();
    assert_eq!(
        meta.get(&doc.doc.transact(), "schemaVersion"),
        Some(Out::Any(Any::Number(1.0)))
    );
}

#[test]
fn nested1b_canonical_frontmatter_fold_drops_redundant_witness() {
    let source = "---\nstatus: open\n---\n- parent\n  - child";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    let body = doc.canonical_content()["body"].clone();
    let chosen = source.replace("open", "done");
    doc.replace_frontmatter_for_fold(&chosen).unwrap();
    assert_eq!(doc.project_richdoc().unwrap(), chosen);
    assert_eq!(doc.canonical_content()["body"], body);
    assert!(doc.markdown_source_reference().is_none());
}

#[test]
fn nested1b_flat_unsupported_marker_keeps_builder_refusal() {
    let source = "-\tparent\n  - child";
    // Source retains two flat items here, not an item-block body. The native
    // builders still refuse its unsupported marker indentation, as on main.
    let normalized = normalize_list_tabs(source, MarkdownReading::Source);
    let (blocks, _) = parse_markdown_blocks_checked(&normalized, MarkdownReading::Source);
    assert!(!refused_fold_item_bodies(&blocks));
    assert!(successor(source).is_err());
    assert!(Ydoc::wire()
        .seed_collection_relation_markdown(source)
        .is_err());
}

fn held_sources() -> [&'static str; 18] {
    [
        "- a\n\n- b\n  - c",
        "- p\n  - a\n\n  - b",
        "* parent\n  * a\n\n  * b\n",
        "1. a\n    1. child\n\n2. b\n",
        "- parent\n  - child\n\n| h |\n| --- |\n| v |\n",
        "- step\n\n  $$\n  x^2\n  $$\n  - sub\n",
        "- $$\n  x^2\n  $$\n  - sub\n",
        "- parent\n\n  <div\n  - child",
        "- parent\n\n  <div \n  - child",
        "- parent\n\n  <pre\n  - child",
        "- a\n\n  ```\n  code\n  ````\n  <div>\n  ```\n",
        "- a\n\n  ```\n  code\n   ```\n  <div>\n  ```\n",
        "```bad`info\n```\n- a\n  - child\n  <div>\n```\n",
        "- parent\n  - child\n\n> [link](https://example.com)",
        "- parent\n  - child\n\n> &amp;",
        "- parent\n  - child\n\n<!-- dohc:table row-heights=1:40 -->\n| h |\n| --- |\n| [link](https://example.com) |",
        "- [link](https://example.com) and `code`\n  - child",
        "- ~~strike~~ &amp; \\*literal\\*\n  - child",
    ]
}

fn generated_sources() -> Vec<String> {
    let mut sources = Vec::new();
    for parent in ["-", "*", "+", "1.", "3)", "- [ ]", "* [x]", "+ [X]"] {
        for child in ["-", "*", "+", "1.", "0)", "- [ ]", "* [x]", "+ [X]"] {
            for indent in [2, 4] {
                let width = if parent.as_bytes()[0].is_ascii_digit() {
                    3
                } else {
                    2
                };
                if indent < width {
                    continue;
                }
                for loose in [false, true] {
                    for shape in [0, 1, 2] {
                        let gap = if loose { "\n" } else { "" };
                        let pad = " ".repeat(indent);
                        let continuation = " ".repeat(width);
                        let tail = match shape {
                            0 => String::new(),
                            1 => format!("\n\n{continuation}second paragraph"),
                            _ => format!("\n\n{continuation}```txt\n{continuation}literal code\n{continuation}```"),
                        };
                        let grand = " ".repeat(
                            indent
                                + if child.as_bytes()[0].is_ascii_digit() {
                                    4
                                } else {
                                    2
                                },
                        );
                        let base = format!(
                            "{parent} parent\n{gap}{pad}{child} child\n{grand}- grandchild{tail}"
                        );
                        for crlf in [false, true] {
                            for eof in [false, true] {
                                let source = format!("{base}{}", if eof { "\n" } else { "" });
                                sources.push(if crlf {
                                    source.replace('\n', "\r\n")
                                } else {
                                    source
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    for parent in [
        "-", "*", "+", "1.", "3)", "- [ ]", "* [x]", "+ [X]", "1. [ ]", "3) [X]",
    ] {
        let width = if parent.as_bytes()[0].is_ascii_digit() {
            4
        } else {
            2
        };
        for level in 0..4 {
            for inline in [
                "plain",
                "**bold** and *emphasis*",
                "`code` and \\*literal\\*",
                "~~strike~~ a & b",
            ] {
                let mut source = String::new();
                for depth in 0..4 {
                    source.push_str(&format!("{}{parent} {inline}\n", " ".repeat(depth * width)));
                }
                // Tight siblings at each level, including later ordered starts.
                let sibling = if parent.starts_with("1.") {
                    parent.replacen("1.", "2.", 1)
                } else if parent.starts_with("3)") {
                    parent.replacen("3)", "4)", 1)
                } else {
                    parent.to_owned()
                };
                source.push_str(&format!("{}{sibling} sibling", " ".repeat(level * width)));
                for surround in [false, true] {
                    sources.push(if surround { format!("---\ntitle: 'quoted'\nstatus: open\n---\n# Before\n\n{source}\n\nAfter\n\n```txt\nliteral\n```\n") } else { source.clone() });
                }
            }
        }
    }
    sources.extend(
        [
            "- parent\n  - child\n  - next\n- sibling",
            "- parent\n\n  ```txt\n  literal\n  ```\n  - child",
            "# Heading\n\n- parent\n  - child\n\n> **bold** and *emphasis*\n\n---",
            "- parent\n  - child\n\n<!-- dohc:table row-heights=1:40 -->\n| h |\n| --- |\n| plain |",
        ]
        .map(str::to_owned),
    );
    sources
}

fn production_docs(source: &str) -> [Ydoc; 2] {
    let successor =
        successor(source).unwrap_or_else(|error| panic!("successor {source:?}: {error}"));
    let doc = Ydoc::wire();
    doc.apply(&successor.update).unwrap();
    let relation = Ydoc::wire();
    relation
        .seed_collection_relation_markdown(source)
        .unwrap_or_else(|error| panic!("relation {source:?}: {error}"));
    [doc, relation]
}

fn witness(doc: &Ydoc) -> Value {
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    let txn = doc.doc.transact();
    json!([
        MARKDOWN_SOURCE_META_KEY,
        MARKDOWN_SOURCE_SHA_META_KEY,
        MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY
    ]
    .map(|key| match meta.get(&txn, key) {
        Some(Out::Any(Any::String(value))) => json!(value.as_ref()),
        None => Value::Null,
        other => panic!("unexpected witness field: {other:?}"),
    }))
}

#[test]
fn nested1b_positive_grammar_and_strict_admission_remains_off() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested1b-allowlist-witnesses.json"
    ))
    .unwrap();
    let sources = generated_sources();
    assert_eq!(sources.len() + held_sources().len(), fixtures.len());
    assert_eq!(
        fixtures.iter().filter(|row| row["held"] == true).count(),
        held_sources().len()
    );
    for (source, fixture) in held_sources()
        .into_iter()
        .zip(fixtures.iter().filter(|row| row["held"] == true))
    {
        assert_eq!(fixture["source"], source);
        assert_eq!(fixture["builders"].as_array().unwrap().len(), 0);
        assert!(!outside_markdown_is_allowlisted(source));
        assert!(successor(source).is_err());
        assert!(Ydoc::wire()
            .seed_collection_relation_markdown(source)
            .is_err());
    }
    for (source, fixture) in sources
        .into_iter()
        .zip(fixtures.iter().filter(|row| row["held"] != true))
    {
        assert!(outside_markdown_is_allowlisted(&source), "{source:?}");
        assert_eq!(fixture["source"], source);
        assert_eq!(fixture["builders"].as_array().unwrap().len(), 2);
        let source_doc = Ydoc::wire();
        source_doc
            .rewrite_content_to_markdown_as(ContentKind::Richdoc, &source, MarkdownReading::Source)
            .unwrap();
        for (doc, builder) in production_docs(&source)
            .into_iter()
            .zip(fixture["builders"].as_array().unwrap())
        {
            assert_eq!(
                doc.canonical_content()["body"],
                source_doc.canonical_content()["body"],
                "{source:?}"
            );
            assert_eq!(
                doc.canonical_content()["body"],
                fixture["body"],
                "{source:?}"
            );
            assert_eq!(witness(&doc), builder["witness"], "{source:?}");
            let canonical = doc.project_richdoc().unwrap();
            let expected = if canonical == source {
                json!([null, null, null])
            } else {
                json!([
                    source,
                    crate::hex_sha256(source.as_bytes()),
                    crate::hex_sha256(canonical.as_bytes())
                ])
            };
            assert_eq!(witness(&doc), expected, "{source:?}");
            let replay = Ydoc::wire();
            replay
                .apply(
                    &base64::engine::general_purpose::STANDARD
                        .decode(builder["nativeBase64"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
            assert_eq!(witness(&doc), witness(&replay), "{source:?}");
            assert_eq!(
                doc.project_richdoc().unwrap(),
                fixture["canonical"].as_str().unwrap(),
                "{source:?}"
            );
        }
    }
}

#[test]
fn nested1b_changed_nested_fold_still_refuses() {
    for source in [
        "- parent\n  - child",
        "1. parent\n    1. child",
        "- [X] parent\n  - [x] child",
    ] {
        let doc = Ydoc::wire();
        assert!(
            matches!(
                doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source),
                Err(CollabError::MarkdownNotRepresentable)
            ),
            "{source:?}"
        );
    }
}

#[test]
fn nested1b_non_allowlisted_shapes() {
    for source in [
        "- a\n  ---",
        "- a\n  ===",
        "- a\n\n  # heading",
        "- a\n\n  > quote",
        "- a\n\n  | h |\n  | --- |\n  | v |",
        "- a\n\n  <div>html</div>",
        "- parent\n\n  </custom >\n  - child",
        "- parent\n\n  </custom\t>\n  - child",
        "- parent\n\n  </custom> \n  - child",
        "- parent\n\n  <my_tag>\n  - child",
        "- parent\n\n  <meta>text\n  - child",
        "- a\n\n      indented code",
        "- a\n\n  ~~~\n  code\n  ~~~",
        "-\n  - child",
        "- a\n  - child\nlazy",
        "- a\n\t- child",
        "- parent\n  - \tchild",
        "- parent\n  - [x]\tchild",
        "- a\n   - child",
        "- a\n     - child",
    ] {
        assert!(!outside_markdown_is_allowlisted(source), "{source:?}");
    }
}

#[test]
fn nested1b_inline_tags_are_not_html_blocks() {
    for source in [
        "- parent\n\n  <div:foo>\n  - child",
        "- parent\n\n  <span>inline</span>\n  - child",
        "- parent\n\n  <prelude>inline</prelude>\n  - child",
        "- parent\n\n  <_foo>\n  - child",
    ] {
        assert!(outside_markdown_is_allowlisted(source), "{source:?}");
    }
}

#[test]
fn nested1b_fresh_witness_band() {
    let prefix = "- parent\n  - ";
    for bytes in [
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES,
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES + 1,
    ] {
        let source = prefix.to_owned() + &"p".repeat(bytes - prefix.len());
        assert_eq!(
            outside_markdown_is_allowlisted(&source),
            bytes <= crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        );
    }
    // Flat files do not need the nested grammar, but a fresh noncanonical
    // successor must still obey the public witness band.
    for bytes in [
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES,
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES + 1,
    ] {
        let source = "* ".to_owned() + &"p".repeat(bytes - 2);
        let digest = crate::hex_sha256(source.as_bytes());
        let key = crate::DocKey::new("workspace", "main", "object").unwrap();
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: "claim",
            predecessor_state_vector_sha256: "vector",
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: "preimage",
            content_kind: ContentKind::Richdoc,
            result_sha256: &digest,
        });
        let result = fresh_successor_base(&identity, &source);
        assert_eq!(
            result.is_ok(),
            bytes <= crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        );
    }
}

#[test]
fn nested1b_forged_witness_is_not_authority() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        "- parent\n  - child",
        MarkdownReading::Source,
    )
    .unwrap();
    let canonical = doc.project_richdoc().unwrap();
    doc.record_validated_markdown_source_reference("* forged\n  * child")
        .unwrap();
    assert!(doc.preserved_markdown_source(&canonical).is_none());
    // Native baseline validation accepts well-formed metadata, but projection
    // drops an unproved source. It must never become artifact authority.
    doc.validate_public_baseline(&doc.encode_full_state())
        .unwrap();
    assert_eq!(doc.project_richdoc().unwrap(), canonical);
    assert_ne!(canonical, "* forged\n  * child");
}

#[test]
#[ignore = "regenerate production-builder differential witnesses"]
fn nested1b_export_differential_witnesses() {
    let mut rows = Vec::new();
    for source in generated_sources() {
        assert!(outside_markdown_is_allowlisted(&source), "{source:?}");
        let docs = production_docs(&source);
        let doc = &docs[0];
        let canonical = doc.project_richdoc().unwrap();
        let builders: Vec<_> = docs.iter().map(|doc| {
            if canonical != source {
                assert_eq!(doc.preserved_markdown_source(&canonical).as_deref(), Some(source.as_str()), "{source:?}");
            }
            // The public journal schema excludes the private successor epoch.
            if doc.lineage_epoch_tag().is_none() {
                doc.validate_public_baseline(&doc.encode_full_state()).unwrap();
            }
            json!({"nativeBase64": base64_encode(&doc.encode_full_state()), "witness": witness(doc)})
        }).collect();
        rows.push(json!({"source": source, "canonical": canonical, "body": doc.canonical_content()["body"], "builders": builders}));
    }
    for source in held_sources() {
        assert!(!outside_markdown_is_allowlisted(source), "{source:?}");
        assert!(successor(source).is_err(), "{source:?}");
        assert!(
            Ydoc::wire()
                .seed_collection_relation_markdown(source)
                .is_err(),
            "{source:?}"
        );
        rows.push(json!({"source": source, "held": true, "builders": []}));
    }
    std::fs::write(
        std::env::var("DOHC_NESTED1B_DIFFERENTIAL").unwrap(),
        serde_json::to_vec(&rows).unwrap(),
    )
    .unwrap();
}

#[test]
fn nested1b_frontmatter_stage_keeps_unwitnessed_body_xml() {
    let initial = "---\nstatus: open\n---\n* parent\n\n    * child\n";
    let chosen = initial.replace("open", "done");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, initial)
        .unwrap();
    assert!(doc.markdown_source_reference().is_none());
    let body = doc.canonical_content()["body"].clone();
    doc.replace_frontmatter_for_fold(&chosen).unwrap();
    assert_eq!(doc.canonical_content()["body"], body);
    assert_eq!(
        doc.preserved_markdown_source(&doc.project_richdoc().unwrap())
            .as_deref(),
        Some(chosen.as_str())
    );

    let _ = doc.richdoc_append_paragraph("Unsettled body edit");
    let edited = doc.canonical_content()["body"].clone();
    doc.replace_frontmatter_for_fold(initial).unwrap();
    assert_eq!(doc.canonical_content()["body"], edited);
    let canonical = doc.project_richdoc().unwrap();
    assert!(doc.preserved_markdown_source(&canonical).is_none());
    assert_eq!(
        doc.settled_markdown_source(&canonical, || Ok::<_, ()>(Some(initial.to_owned()))),
        Ok(None)
    );
}
