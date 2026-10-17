use super::*;

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
    sources
}

#[test]
fn nested1b_positive_grammar_and_strict_admission_remains_off() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested1b-allowlist-witnesses.json"
    ))
    .unwrap();
    let sources = generated_sources();
    assert_eq!(sources.len(), fixtures.len());
    for (source, fixture) in sources.into_iter().zip(fixtures) {
        assert!(outside_markdown_is_allowlisted(&source), "{source:?}");
        assert_eq!(fixture["source"], source);
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, &source, MarkdownReading::Source)
            .unwrap();
        assert_eq!(
            doc.canonical_content()["body"],
            fixture["body"],
            "{source:?}"
        );
        assert_eq!(
            doc.project_richdoc().unwrap(),
            fixture["canonical"].as_str().unwrap(),
            "{source:?}"
        );
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
        "-\tparent\n  - child",
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
#[ignore = "regenerate native Source differential witnesses"]
fn nested1b_export_differential_witnesses() {
    let mut rows = Vec::new();
    for (at, source) in generated_sources().into_iter().enumerate() {
        assert!(outside_markdown_is_allowlisted(&source), "{source:?}");
        let doc = Ydoc::with_client_id(1000 + at as u64);
        doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, &source, MarkdownReading::Source)
            .unwrap();
        let canonical = doc.project_richdoc().unwrap();
        doc.preserve_folded_markdown_source(&source).unwrap();
        assert_eq!(
            doc.preserved_markdown_source(&canonical).as_deref(),
            Some(source.as_str()),
            "{source:?}"
        );
        doc.validate_public_baseline(&doc.encode_full_state())
            .unwrap();
        rows.push(json!({"source": source, "canonical": canonical, "body": doc.canonical_content()["body"], "nativeBase64": base64_encode(&doc.encode_full_state())}));
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
