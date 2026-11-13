use super::*;

fn nested_contract_body(doc: &Ydoc) -> Value {
    let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    out_json(&doc.doc.transact(), Out::YXmlFragment(body))
}

fn nested_contract_marked_start(doc: &Ydoc, case: &Value) {
    let Some(mark) = case["markedStart"].as_object() else {
        return;
    };
    let fragment = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let mut txn = doc.doc.transact_mut();
    let mut node = fragment.get(&txn, 0).unwrap();
    loop {
        match node {
            XmlOut::Element(element) => node = element.get(&txn, 0).unwrap(),
            XmlOut::Text(text) => {
                let len = text.len(&txn);
                text.remove_range(&mut txn, 0, len);
                text.insert_with_attributes(
                    &mut txn,
                    0,
                    case["markedText"].as_str().unwrap(),
                    yrs::types::Attrs::from([(
                        mark["type"].as_str().unwrap().into(),
                        json_to_any(mark.get("attrs").unwrap_or(&json!({}))),
                    )]),
                );
                return;
            }
            _ => panic!("expected paragraph text"),
        }
    }
}

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
        nested_contract_marked_start(&doc, case);
        assert_eq!(
            doc.project_richdoc().unwrap(),
            case["canonical"].as_str().unwrap(),
            "{name}"
        );
        let canonical = case["canonical"].as_str().unwrap();
        let body = nested_contract_body(&doc);
        if case["markedStart"].is_object() {
            // Editor mark fixtures check projection; Markdown import keeps inline syntax as text.
            let replay = Ydoc::wire();
            replay.apply(&doc.encode_full_state()).unwrap();
            assert_eq!(replay.project_richdoc().unwrap(), canonical, "{name}");
            doc.validate_public_baseline(&doc.encode_full_state())
                .unwrap();
            return;
        }
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
        if case["stableTree"] == true {
            assert_eq!(nested_contract_body(&doc), body, "{name}: reread tree");
        }
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
        if case["foldSeed"] == true {
            doc.rewrite_content_to_markdown_for_fold(
                ContentKind::Richdoc,
                case["source"].as_str().unwrap(),
            )
            .unwrap();
        } else {
            doc.rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                case["nativeSeedSource"].as_str().unwrap_or(
                    if case["nativeSourceRefuse"] == true {
                        case["canonical"].as_str().unwrap()
                    } else {
                        case["source"].as_str().unwrap()
                    },
                ),
                if case["projected"] == true && case["nativeSeedSource"].is_null()
                    || case["nativeSourceRefuse"] == true
                {
                    MarkdownReading::ProjectedSource
                } else {
                    MarkdownReading::Source
                },
            )
            .unwrap();
        }
        nested_contract_marked_start(&doc, case);
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
fn fix1_projected_fences_are_accepted_unchanged() {
    for language in ["js", "lang`tick", "~lang`tick"] {
        for content in ["", "code", "before\n~~~\n```\nafter"] {
            let attrs = BTreeMap::from([("language".into(), Value::String(language.into()))]);
            let children = vec![MarkdownNode::Text(vec![TextRun {
                text: content.into(),
                marks: Vec::new(),
            }])];
            let canonical = format!("{}\n", render_code_block(&attrs, &children).unwrap());
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &canonical)
                .unwrap();
            assert_eq!(doc.project_richdoc().unwrap(), canonical);
        }
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
            format!("{expected}\n\nEdited\n")
        );
    }
}

#[test]
fn nested_contract_r26_boundaries_in_every_reading() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["name"].as_str().unwrap().starts_with("r26-"))
    {
        for reading in [
            MarkdownReading::Source,
            MarkdownReading::Projection,
            MarkdownReading::ProjectedSource,
            MarkdownReading::Successor,
        ] {
            let result = std::panic::catch_unwind(|| {
                let doc = Ydoc::wire();
                let result = doc.rewrite_content_to_markdown_as(
                    ContentKind::Richdoc,
                    case["source"].as_str().unwrap(),
                    reading,
                );
                if case["refuse"] == true {
                    assert!(result.is_err());
                    return;
                }
                result.unwrap();
                assert_eq!(
                    doc.project_richdoc().unwrap(),
                    case["canonical"].as_str().unwrap()
                );
            });
            if result.is_err() {
                failures.push(format!("{}: {reading:?}", case["name"]));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}
