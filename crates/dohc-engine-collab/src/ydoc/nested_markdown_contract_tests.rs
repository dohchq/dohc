use super::*;

fn nested_contract_case(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let doc = Ydoc::wire();
    let result = doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        case["source"].as_str().unwrap(),
        if case["projected"] == true {
            MarkdownReading::ProjectedSource
        } else {
            MarkdownReading::Source
        },
    );
    if case["refuse"].as_bool() == Some(true) {
        assert!(result.is_err(), "{name}: unsupported source was accepted");
    } else {
        result.unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            case["canonical"].as_str().unwrap(),
            "{name}"
        );
        let canonical = case["canonical"].as_str().unwrap();
        if case["exactSource"] == true {
            let source = case["source"].as_str().unwrap();
            doc.preserve_folded_markdown_source(source).unwrap();
            assert_eq!(
                doc.preserved_markdown_source(canonical).as_deref(),
                Some(source)
            );
        }
        doc.rewrite_content_to_markdown_as(
            ContentKind::Richdoc,
            canonical,
            MarkdownReading::ProjectedSource,
        )
        .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), canonical);
        let replay = Ydoc::wire();
        replay.apply(&doc.encode_full_state()).unwrap();
        assert_eq!(replay.project_richdoc().unwrap(), canonical);
        doc.validate_public_baseline(&doc.encode_full_state())
            .unwrap();
    }
}
#[test]
fn nested_contract_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let failures: Vec<_> = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| std::panic::catch_unwind(|| nested_contract_case(case)).is_err())
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert!(failures.is_empty(), "failed corpus cases: {failures:?}");
}

#[test]
fn nested_contract_file_fold_accepts_rules_and_prose() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    for case in corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["fileFold"] == true)
    {
        let doc = Ydoc::wire();
        let source = case["source"].as_str().unwrap();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .expect(source);
        assert_eq!(
            doc.project_richdoc().unwrap(),
            case["canonical"].as_str().unwrap(),
            "{source}"
        );
        doc.preserve_folded_markdown_source(source).expect(source);
        assert_eq!(
            doc.preserved_markdown_source(&doc.project_richdoc().unwrap())
                .as_deref(),
            Some(source).filter(|_| case["witnessRefuse"] != true)
        );
    }
}

#[test]
fn nested_contract_combines_list_and_quote_depth() {
    let source = |quotes: usize, lists: usize| {
        let mut body = String::new();
        for level in 0..lists {
            body.push_str(&"> ".repeat(quotes));
            body.push_str(&"  ".repeat(level));
            body.push_str("- item\n");
        }
        body
    };
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source(5, 60))
        .unwrap();
    let mut inner_quote = source(0, 60);
    inner_quote.push_str(&format!("{}> quoted\n", "  ".repeat(60)));
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &inner_quote)
        .unwrap();
    assert!(doc.project_richdoc().unwrap().contains("> quoted"));
    assert!(doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, &source(9, 60))
        .is_err());
}

#[test]
fn nested_contract_file_fold_refuses_before_mutation() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Original")
        .unwrap();
    let before = doc.encode_full_state();
    for source in ["- parent\n  - child\n", "1. parent\n\n   continuation\n"]
        .into_iter()
        .chain(
            corpus["cases"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|case| case["foldRefuse"] == true)
                .map(|case| case["source"].as_str().unwrap()),
        )
    {
        assert!(doc
            .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .is_err());
        assert_eq!(doc.encode_full_state(), before);
    }
}

#[test]
fn nested_contract_seeds_schema_version() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "10. parent\n    - child")
        .unwrap();
    assert_eq!(
        doc.canonical_content()["meta"]["value"]["schemaVersion"]["value"],
        json!(1)
    );
}

#[test]
#[ignore = "regenerate development contract seeds"]
fn regenerate_nested_contract_seeds() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tools/rust-engine-program/nested-markdown-contract.json"
    );
    let mut corpus: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in corpus["cases"].as_array_mut().unwrap() {
        if case["refuse"].as_bool() == Some(true) {
            continue;
        }
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_as(
            ContentKind::Richdoc,
            case["source"].as_str().unwrap(),
            if case["projected"] == true {
                MarkdownReading::ProjectedSource
            } else {
                MarkdownReading::Source
            },
        )
        .unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            case["canonical"].as_str().unwrap()
        );
        case["rustBase64"] = json!(base64_encode(&doc.encode_full_state()));
    }
    std::fs::write(path, serde_json::to_string_pretty(&corpus).unwrap() + "\n").unwrap();
}

#[test]
fn fix1_ordinary_block_lines_are_not_list_refusals() {
    for source in [
        "Mr. Smith arrived.",
        "Dr. Jones",
        "St. Louis",
        "I. Overview",
        "Intro\nMr. Jones",
        "***",
        "___",
        "~~~\ncode\n~~~",
        "\tliteral",
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, source, MarkdownReading::Source)
            .unwrap();
        assert!(!doc.project_richdoc().unwrap().is_empty());
    }
}

#[test]
fn fix1_ordinary_prose_keeps_its_exact_source_witness() {
    let source = "Mr. Smith arrived.\nIntro\nDr. Jones\nSt. Louis\nI. Overview\n";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    let projection = doc.project_richdoc().unwrap();
    assert_eq!(
        doc.preserved_markdown_source(&projection).as_deref(),
        Some(source)
    );
}

#[test]
fn fix1_public_rewrite_reads_projected_markdown() {
    for source in ["- one\n\n- two", "| a | b |\n| --- | --- |\n| x | y |"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), source);
    }
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &format!("{}quoted", "> ".repeat(121)))
        .unwrap();
    doc.rewrite_content_to_markdown(
        ContentKind::Richdoc,
        "- parent\n\n  | a | b |\n  | --- | --- |\n  | x | y |",
    )
    .unwrap();
    assert!(doc.canonical_content()["body"]
        .to_string()
        .contains("\"table\""));
}

#[test]
fn fix1_plain_bullets_in_the_middle_keep_borrowed_text() {
    let source = "# Before\n\n- first\n- second\n\n# After\n\nParagraph";
    let blocks = parse_markdown_blocks(source, MarkdownReading::Source);
    assert!(
        matches!(&blocks[1], MdBlock::BulletList(MdBulletItems::Plain(items)) if items == &["first", "second"])
    );
}

#[test]
fn fix1_projected_fences_are_accepted_unchanged() {
    for language in ["js", "lang`tick", "~lang`tick"] {
        for content in ["", "code", "before\n~~~\n```\nafter"] {
            let attrs = BTreeMap::from([("language".into(), Value::String(language.into()))]);
            let children = vec![MarkdownNode::Text(vec![TextRun {
                text: content.into(),
                marks: Vec::new(),
            }])];
            let canonical = render_code_block(&attrs, &children).unwrap();
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &canonical)
                .unwrap();
            assert_eq!(doc.project_richdoc().unwrap(), canonical);
        }
    }
}

#[test]
fn fix1_projected_paragraph_indent_is_accepted_unchanged() {
    for canonical in ["&#32; literal", "&#32;  \\- x", "&#9;literal"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, canonical)
            .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), canonical);
    }
}

#[test]
fn fix1_spaced_rules_keep_root_acceptance() {
    let blocks = parse_markdown_blocks("* * *", MarkdownReading::Source);
    assert!(matches!(&blocks[0], MdBlock::Rule));
    for source in ["* * *", "_ _ _"] {
        Ydoc::wire()
            .rewrite_content_to_markdown_as(ContentKind::Richdoc, source, MarkdownReading::Source)
            .unwrap();
    }
}

#[test]
fn fix1_projected_item_prose_is_accepted_unchanged() {
    for source in ["- Mr. Smith arrived.", "- I. Overview", "- a. child"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), source);
    }
}
