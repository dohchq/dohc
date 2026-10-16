use super::*;

fn nested_contract_case(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let doc = Ydoc::wire();
    if case["nativeSourceRefuse"] == true {
        assert!(doc
            .rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                case["source"].as_str().unwrap(),
                MarkdownReading::Source
            )
            .is_err());
    }
    let result = doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        case["nativeSeedSource"]
            .as_str()
            .unwrap_or(if case["nativeSourceRefuse"] == true {
                case["canonical"].as_str().unwrap()
            } else {
                case["source"].as_str().unwrap()
            }),
        if case["projected"] == true && case["nativeSeedSource"].is_null()
            || case["nativeSourceRefuse"] == true
        {
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
        let canonical = case["nativeRereadCanonical"].as_str().unwrap_or(canonical);
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
        let canonical = case["foldCanonical"]
            .as_str()
            .unwrap_or_else(|| case["canonical"].as_str().unwrap());
        assert_eq!(doc.project_richdoc().unwrap(), canonical, "{source}");
        if case["foldCanonical"].is_string() {
            // Production skips a source witness when the fold already writes
            // the chosen bytes. Source import and projected reading differ here.
            assert_eq!(canonical, source);
            assert!(doc.preserved_markdown_source(canonical).is_none());
            doc.validate_public_baseline(&doc.encode_full_state())
                .unwrap();
            continue;
        }
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
fn nested_contract_marker_tabs_after_legacy_source_fence() {
    // Source keeps main's three-backtick closer even for a wider opener.
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        "````\nbody\ttext\n```\n-\titem",
        MarkdownReading::Source,
    )
    .unwrap();
    let canonical = doc.project_richdoc().unwrap();
    assert!(canonical.contains("body\ttext"));
    assert!(canonical.ends_with("\n\n- item"), "{canonical}");
}

#[test]
fn nested_contract_projected_lazy_tabs_remain_content() {
    for source in ["- a\nlazy\ttext", "- a\n b\tc", "1. a\nlazy\ttext"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, source, MarkdownReading::Source)
            .unwrap();
        let canonical = doc.project_richdoc().unwrap();
        assert!(canonical.contains('\t'));
        for reading in [
            MarkdownReading::Projection,
            MarkdownReading::ProjectedSource,
        ] {
            doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, &canonical, reading)
                .unwrap();
            assert_eq!(doc.project_richdoc().unwrap(), canonical);
        }
    }
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
            case["nativeSeedSource"]
                .as_str()
                .unwrap_or(if case["nativeSourceRefuse"] == true {
                    case["canonical"].as_str().unwrap()
                } else {
                    case["source"].as_str().unwrap()
                }),
            if case["projected"] == true && case["nativeSeedSource"].is_null()
                || case["nativeSourceRefuse"] == true
            {
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
        if case["witnessSeed"] == true {
            doc.preserve_folded_markdown_source(case["source"].as_str().unwrap())
                .unwrap();
        }
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
        "&#9;literal",
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

#[test]
fn projected_raw_html_keeps_line_start_entities() {
    for (open, close) in [
        ("<foo>", "</foo>"),
        ("<foo_bar>", "</foo_bar>"),
        ("<foo>", "</foo-x>"),
        ("<foo>", "</foo:x>"),
        ("<foo>", "<foo-x>c</foo-x>"),
        ("<span class=\"n\">", "</span>"),
        ("<b>", "</b>"),
        ("<details>", "</details>"),
        ("<!--", "-->"),
        ("<?", "?>"),
        ("<!A ", ">"),
        ("<![CDATA[", "]]>"),
        ("<strong>", "</strong>"),
        ("<em>", "</em>"),
    ] {
        for entity in ["&#9;", "&#32;", "&#42;", "2&#46; "] {
            let source = format!("{open}a\n{entity}b{close}");
            let (blocks, refused) =
                parse_markdown_blocks_checked(&source, MarkdownReading::Projection);
            assert!(!refused);
            assert!(
                matches!(&blocks[0], MdBlock::Paragraph(text) if text == &source),
                "{source}"
            );
        }
    }
}

#[test]
fn nested_contract_empty_ordered_ends_before_root_list() {
    for (source, canonical) in [
        ("1.\n\n- b\n  - c", "1. \n\n- b\n  - c"),
        ("1. \n\n- b\n  - c", "1. \n\n- b\n  - c"),
        ("10.\n\n1. b\n   - c", "10. \n\n1. b\n   - c"),
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), canonical);
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, canonical)
            .unwrap();
    }
}

#[test]
fn projected_html_and_definitions_keep_line_start_entities() {
    for source in [
        "x <!-->y<foo>z-->\n&#42;\n</foo>",
        "x <!a<foo>\n&#42;\n</foo>",
        "[a\n&#42;\nb]: /u",
        "[a]: /u\n\"t\n&#42;\nx\"",
        "<foo>\n&#9;b",
        "<foo>\n&#32;b",
        "<foo>\n&#42;",
        "<foo>\n2&#46; b",
        "</foo>\n&#9;b",
        "</foo>\n&#32;b",
        "</foo>\n&#42;",
        "</foo>\n2&#46; b",
        "<details>a\n&#9;b",
        "<details>a\n&#32;b",
        "<details>a\n&#42;",
        "<details>a\n2&#46; b",
        "x <!-->y<foo>z-->\n&#9;b</foo>",
        "x <!-->y<foo>z-->\n&#32;b</foo>",
        "x <!-->y<foo>z-->\n&#42;</foo>",
        "x <!-->y<foo>z-->\n2&#46; b</foo>",
        "x <!a<foo>\n&#9;b</foo>",
        "x <!a<foo>\n&#32;b</foo>",
        "x <!a<foo>\n&#42;</foo>",
        "x <!a<foo>\n2&#46; b</foo>",
        "[a\n&#9;b]: /u",
        "[a\n&#32;b]: /u",
        "[a\n&#42;]: /u",
        "[a\n2&#46; b]: /u",
        "[a]: /u\n\"t\n&#9;b\"",
        "[a]: /u\n\"t\n&#32;b\"",
        "[a]: /u\n\"t\n&#42;\"",
        "[a]: /u\n\"t\n2&#46; b\"",
    ] {
        let (blocks, refused) = parse_markdown_blocks_checked(source, MarkdownReading::Projection);
        assert!(!refused);
        assert!(
            matches!(&blocks[0], MdBlock::Paragraph(text) if text == source),
            "{source:?}: {blocks:?}"
        );
    }
}

fn fold_reading_cost(source: &str, plain: &str, label: &str) -> f64 {
    let sources = [source, plain];
    let mut samples = [Vec::new(), Vec::new()];
    for round in 0..5 {
        for index in [round % 2, 1 - round % 2] {
            let doc = Ydoc::wire();
            let started = std::time::Instant::now();
            std::hint::black_box(
                doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, sources[index])
                    .unwrap(),
            );
            samples[index].push(started.elapsed());
        }
    }
    let times = samples.map(|mut values| {
        values.sort();
        values[2]
    });
    println!(
        "{label} {} bytes: repeated {:?}, plain {:?}",
        source.len(),
        times[0],
        times[1]
    );
    times[0].as_secs_f64() / times[1].as_secs_f64()
}

#[test]
fn nested_contract_definition_guard_scales_linearly() {
    let mut smallest = [0.0; 2];
    for bytes in [8_000, 32_000, 128_000, 1_000_000] {
        let mut distinct = String::from("x ");
        for width in 1.. {
            distinct.push_str(&"`".repeat(width));
            distinct.push(' ');
            if distinct.len() >= bytes {
                break;
            }
        }
        let mut linear = true;
        for (shape, (label, mut source)) in [
            (
                "lines before spans",
                format!("{}{}", "x\n".repeat(bytes / 4), "`a` ".repeat(bytes / 8)),
            ),
            ("interleaved spans", "`a`\n".repeat(bytes / 4)),
            ("distinct runs", distinct),
            ("definitions", "[a]:".repeat(bytes / 4)),
        ]
        .into_iter()
        .enumerate()
        {
            if (shape < 2 && ![8_000, 128_000].contains(&bytes)) || (shape >= 2 && bytes == 128_000)
            {
                continue;
            }
            let mut plain: String = source
                .chars()
                .map(|ch| if ch == '\n' { ch } else { 'w' })
                .collect();
            source.push_str("x &#1;");
            plain.push_str("x &#1;");
            let ratio = fold_reading_cost(&source, &plain, label);
            linear &= if shape < 2 {
                let bounded = smallest[shape] == 0.0 || ratio <= smallest[shape] * 8.0;
                if smallest[shape] == 0.0 {
                    smallest[shape] = ratio;
                }
                bounded
            } else {
                ratio <= 8.0
            };
        }
        assert!(linear, "superlinear fold reading at {bytes} bytes");
    }
}

#[test]
fn folded_code_marks_stop_at_each_span() {
    for (source, expected) in [
        (
            "a `b` c `d` e &#1;",
            json!([
                {"insert":"a "}, {"insert":"b","attrs":{"code":{}}}, {"insert":" c "},
                {"insert":"d","attrs":{"code":{}}}, {"insert":" e &#1;"}
            ]),
        ),
        (
            "`b` c &#1;",
            json!([{"insert":"b","attrs":{"code":{}}}, {"insert":" c &#1;"}]),
        ),
        (
            "a &#1; `b`",
            json!([{"insert":"a &#1; "}, {"insert":"b","attrs":{"code":{}}}]),
        ),
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .unwrap();
        assert_eq!(
            doc.canonical_content()["body"]["children"][0]["children"][0]["delta"],
            expected
        );
    }
}

#[test]
fn folded_code_keeps_following_markdown_on_first_edit() {
    for (source, expected) in [
        ("a `b` *c* [l](u) &#1;", "a `b` *c* [l](u) &amp;#1;"),
        (
            "Write `&amp;` as `&#38;` in HTML.",
            "Write `&amp;` as `&#38;` in HTML.",
        ),
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .unwrap();
        doc.preserve_folded_markdown_source(source).unwrap();
        doc.richdoc_append_paragraph("Edited");
        assert_eq!(
            doc.project(ContentKind::Richdoc).unwrap().content,
            format!("{expected}\n\nEdited")
        );
    }
}

#[test]
fn folded_code_preserves_noncanonical_span_spelling() {
    for source in ["Use ``make`` then &#", "a ` b ` &#"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .unwrap();
        doc.preserve_folded_markdown_source(source).unwrap();
        assert_eq!(
            doc.preserved_markdown_source(&doc.project_richdoc().unwrap())
                .as_deref(),
            Some(source)
        );
    }
}
