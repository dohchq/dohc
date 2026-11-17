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

/// The cases past the reader's depth limits, which the editor refuses too.
const TOO_DEEP: &[&str] = &[
    "quotes-in-deep-item",
    "quote-overflow",
    "padded-round12-bullet-depth",
    "padded-round12-ordered-depth",
];

/// The cases this reader reads unlike the editor's reader, by reason. Each
/// follows CommonMark where the editor's Markdown library does not, and
/// keeps the text the file holds.
const READS_UNLIKE_THE_EDITOR: &[(&str, &[&str])] = &[
    (
        "A lazy or under-indented line continues the paragraph above it, and \
         a block an item's indentation leaves out ends the item",
        &[
            "task-blank-continuation",
            "task-lazy-continuation",
            "empty-bullet-tab-continuation",
            "empty-bullet-space-tab-continuation",
            "empty-bullet-blank-child-marker",
            "quote-lazy-indented-line",
            "lazy-underindented-interior-tab",
            "r24-bare-structural",
            "r24-deep-lazy",
            "r24-nested-deep-lazy",
            "r25-deep-marker-bullet",
            "r25-deep-marker-ordered",
            "r26-hashtag-next",
            "r26-hashtag-marker",
            "r26-hashtag-continuation",
            "r26-hashtag-number",
            "r26-deep-heading",
            "r26-deep-fence",
            "r26-deep-ordered-heading",
        ],
    ),
    (
        "The spaces that end a list's last paragraph stay text, as they do at \
         the end of other paragraphs, where the editor drops them",
        &[
            "r23-slow-spaces-heading-0",
            "r23-slow-spaces-nested-0",
            "r23-slow-spaces-heading-1",
            "r23-slow-spaces-nested-1",
            "r23-slow-spaces-heading-2",
            "r23-slow-spaces-nested-2",
            "r24-final-block-spaces",
            "r25-quote-bullet",
            "r25-quote-ordered",
            "r25-quote-task",
            "r25-quote-nested",
            "r25-quote-recursive",
        ],
    ),
    (
        "The tab that ends a setext heading's text is dropped, as CommonMark \
         drops it, where the editor keeps it",
        &["item-setext-trailing-tab"],
    ),
    (
        "An NBSP that ends a paragraph stays text, as CommonMark keeps it, \
         where the editor drops it",
        &["item-setext-trailing-nbsp", "r24-final-nbsp"],
    ),
    (
        "Emphasis is read in a list whose last item ends with spaces, where \
         the editor keeps it as text",
        &[
            "r23-slow-spaces-inline-0",
            "r23-slow-spaces-inline-1",
            "r23-slow-spaces-inline-2",
        ],
    ),
    (
        "A setext underline in an item makes its whole paragraph the heading",
        &[
            "item-setext-rule-disagreement",
            "item-setext-after-hash-line",
            "item-setext-two-lines",
        ],
    ),
    (
        "A link reference definition makes a link of the text that uses it",
        &[
            "r23-reference-flat-0",
            "r23-reference-nested-0",
            "r23-reference-quote-0",
            "r23-reference-flat-1",
            "r23-reference-nested-1",
            "r23-reference-quote-1",
            "r23-reference-flat-2",
            "r23-reference-nested-2",
            "r23-reference-quote-2",
        ],
    ),
    (
        "An ordered marker that numbers 1 with leading zeros interrupts a paragraph",
        &[
            "padded-marker-01.-root",
            "padded-marker-01.-item",
            "padded-marker-001)-root",
            "padded-marker-001)-item",
        ],
    ),
    (
        "Indented code drops its trailing blank lines and the tab that indents it",
        &["root-indented-space-line", "root-space-tab-code"],
    ),
    (
        "`$$x$$` alone on a line is display math",
        &["item-math-table-before-ordered", "empty-parent-math"],
    ),
    (
        "Emphasis and links after a tab are read, and the tab stays a tab",
        &["r23-content-1", "r23-content-2", "r24-autolink-tab"],
    ),
    (
        "A quote that starts with `[!note]` is a callout",
        &["fix1-spaces-callout"],
    ),
    (
        "A part the writer cannot write back as it reads keeps its source, \n         where the editor reads it",
        &[
            "empty-task-root",
            "task-marker-changes",
            "ordered-delimiter-change",
            "r25-bare-reread",
        ],
    ),
    (
        "A note with a part the writer cannot write back is read as the \n         writer ends it: without the white space at its end, and with an \n         empty `[X]` item at its end read as text",
        &["empty-task-nested", "r24-end-continued-tab", "r24-end-lazy-tab"],
    ),
];

fn listed(groups: &[(&str, &[&str])], name: &str) -> bool {
    groups.iter().any(|(_, names)| names.contains(&name))
}

/// Each word of a body's text and attributes, such as a link's address, but
/// not of its node names or a link's fixed `rel`, `target` and `class`. A
/// number alone may be a list's, which is markup.
fn nested_contract_words<'v>(value: &'v Value, each: &mut impl FnMut(&'v str)) {
    match value {
        Value::String(text) => text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty() && !word.bytes().all(|byte| byte.is_ascii_digit()))
            .for_each(each),
        Value::Array(items) => items
            .iter()
            .for_each(|item| nested_contract_words(item, each)),
        Value::Object(fields) => fields
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "type" | "tag" | "rel" | "target" | "class"))
            .for_each(|(_, field)| nested_contract_words(field, each)),
        _ => {}
    }
}

fn nested_contract_seed(case: &Value) -> Option<Ydoc> {
    use base64::Engine as _;
    let seed = base64::engine::general_purpose::STANDARD
        .decode(case["rustBase64"].as_str()?)
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&seed).unwrap();
    Some(doc)
}

fn nested_contract_case(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let source = case["source"].as_str().unwrap();
    let doc = Ydoc::wire();
    let result = doc.rewrite_content_to_markdown(ContentKind::Richdoc, source);
    if TOO_DEEP.contains(&name) {
        assert!(
            result.is_err(),
            "{name}: a source past the depth limit was read"
        );
        return;
    }
    result.unwrap();
    nested_contract_marked_start(&doc, case);
    let projection = doc.project_richdoc().unwrap();
    if case["markedStart"].is_object() {
        // Mark fixtures check the projection of the marks the editor sets.
        assert_eq!(projection, case["canonical"].as_str().unwrap(), "{name}");
    } else if let Some(editor) = nested_contract_seed(case) {
        // The seed holds what the editor's reader reads.
        let (editor, read) = (nested_contract_body(&editor), nested_contract_body(&doc));
        assert_eq!(
            editor == read,
            !listed(READS_UNLIKE_THE_EDITOR, name),
            "{name}: reads like the editor"
        );
        // A reading unlike the editor's still keeps each of its words.
        let mut left = HashMap::new();
        nested_contract_words(&read, &mut |word| *left.entry(word).or_insert(0) += 1);
        let mut lost = Vec::new();
        nested_contract_words(&editor, &mut |word| match left.get_mut(word) {
            Some(count) if *count > 0 => *count -= 1,
            _ => lost.push(word.to_owned()),
        });
        assert!(lost.is_empty(), "{name}: loses {lost:?}");
    }
    if case["exactSource"] == true {
        doc.preserve_folded_markdown_source(source).unwrap();
        assert_eq!(
            doc.preserved_markdown_source(&projection).as_deref(),
            Some(source),
            "{name}"
        );
    }
    let again = Ydoc::wire();
    again
        .rewrite_content_to_markdown(ContentKind::Richdoc, &projection)
        .unwrap();
    assert_eq!(
        again.project_richdoc().unwrap(),
        projection,
        "{name}: a second fold writes what the first wrote"
    );
    let replay = Ydoc::wire();
    replay.apply(&doc.encode_full_state()).unwrap();
    assert_eq!(replay.project_richdoc().unwrap(), projection, "{name}");
    doc.validate_public_baseline(&doc.encode_full_state())
        .unwrap();
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
fn nested_contract_file_fold_keeps_the_source_witness() {
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
        let projection = doc.project_richdoc().unwrap();
        doc.preserve_folded_markdown_source(source).expect(source);
        assert_eq!(
            doc.preserved_markdown_source(&projection).as_deref(),
            Some(source).filter(|_| case["witnessRefuse"] != true),
            "{source:?}"
        );
        doc.validate_public_baseline(&doc.encode_full_state())
            .unwrap();
    }
}

#[test]
fn nested_contract_combines_list_and_quote_depth() {
    let source = |quotes: usize, lists: usize| {
        let mut body = String::new();
        for level in 0..lists {
            body.push_str(&"> ".repeat(quotes));
            body.push_str(&"  ".repeat(level));
            body.push_str("- [item](https://example.com)\n");
        }
        body
    };
    let doc = Ydoc::wire();
    // The deepest item's link text sits at 2 * 62 + 1: as deep as the reader
    // goes, and its link still projects. One quote more is too deep.
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source(0, 62))
        .unwrap();
    assert_eq!(doc.project_richdoc().unwrap().matches("[item]").count(), 62);
    assert!(doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, &source(1, 62))
        .is_err());
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
    for source in corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| TOO_DEEP.contains(&case["name"].as_str().unwrap()))
        .map(|case| case["source"].as_str().unwrap())
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
        let name = case["name"].as_str().unwrap();
        // A case this reader reads unlike the editor keeps the editor's seed.
        if case["refuse"] == true || listed(READS_UNLIKE_THE_EDITOR, name) {
            continue;
        }
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, case["source"].as_str().unwrap())
            .unwrap();
        nested_contract_marked_start(&doc, case);
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
