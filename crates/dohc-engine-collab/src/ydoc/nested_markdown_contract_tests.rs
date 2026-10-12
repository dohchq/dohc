use super::*;

fn nested_contract_case(name: &str) {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap();
    let doc = Ydoc::wire();
    let result = doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        case["source"].as_str().unwrap(),
        MarkdownReading::Source,
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
        let replay = Ydoc::wire();
        replay.apply(&doc.encode_full_state()).unwrap();
        assert_eq!(
            replay.project_richdoc().unwrap(),
            doc.project_richdoc().unwrap()
        );
        doc.validate_public_baseline(&doc.encode_full_state())
            .unwrap();
    }
}
macro_rules! nested_contract_test {
    ($test:ident, $case:literal) => {
        #[test]
        fn $test() {
            nested_contract_case($case);
        }
    };
}
nested_contract_test!(nested_contract_flat, "flat");
nested_contract_test!(nested_contract_empty_task_root, "empty-task-root");
nested_contract_test!(nested_contract_empty_task_nested, "empty-task-nested");
nested_contract_test!(
    nested_contract_ordered_checkbox_first_in_bullet,
    "ordered-checkbox-first-in-bullet"
);
nested_contract_test!(
    nested_contract_ordered_first_in_bullet,
    "ordered-first-in-bullet"
);
nested_contract_test!(
    nested_contract_letter_first_in_bullet,
    "letter-first-in-bullet"
);
nested_contract_test!(
    nested_contract_underscore_rule_first_in_bullet,
    "underscore-rule-first-in-bullet"
);
nested_contract_test!(nested_contract_task_checkbox_tab, "task-checkbox-tab");
nested_contract_test!(nested_contract_collection_record, "collection-record");
nested_contract_test!(nested_contract_ordered_checkbox, "ordered-checkbox");
nested_contract_test!(
    nested_contract_ordered_checkbox_sibling,
    "ordered-checkbox-sibling"
);
nested_contract_test!(nested_contract_fence_first_in_item, "fence-first-in-item");
#[test]
fn nested_contract_ordered_fence_first_in_item() {
    nested_contract_case("ordered-fence-first-in-item");
    let doc = Ydoc::wire();
    let source = "1. \n   ```js\n   x()\n   ```";
    doc.rewrite_content_to_markdown_as(
        ContentKind::Richdoc,
        source,
        MarkdownReading::ProjectedSource,
    )
    .unwrap();
    assert_eq!(doc.project_richdoc().unwrap(), source);
}
nested_contract_test!(nested_contract_tilde_in_item, "tilde-in-item");
nested_contract_test!(nested_contract_quotes_in_deep_item, "quotes-in-deep-item");
nested_contract_test!(nested_contract_quote_overflow, "quote-overflow");
nested_contract_test!(nested_contract_tab_after_marker, "tab-after-marker");
nested_contract_test!(nested_contract_tab_item_padding, "tab-item-padding");
nested_contract_test!(nested_contract_task_marker_changes, "task-marker-changes");
nested_contract_test!(
    nested_contract_ordered_delimiter_change,
    "ordered-delimiter-change"
);
nested_contract_test!(nested_contract_ordered_zero, "ordered-zero");
nested_contract_test!(nested_contract_quote_after_lists, "quote-after-lists");
nested_contract_test!(nested_contract_bullet_two, "bullet-two");
nested_contract_test!(nested_contract_bullet_four, "bullet-four");
nested_contract_test!(nested_contract_ordered_three, "ordered-three");
nested_contract_test!(nested_contract_ordered_four, "ordered-four");
nested_contract_test!(nested_contract_wide_ordered, "wide-ordered");
nested_contract_test!(nested_contract_task_casing, "task-casing");
nested_contract_test!(nested_contract_mixed, "mixed");
nested_contract_test!(nested_contract_loose_space_blank, "loose-space-blank");
nested_contract_test!(nested_contract_lazy_continuation, "lazy-continuation");
nested_contract_test!(nested_contract_ordered_continuation, "ordered-continuation");
nested_contract_test!(nested_contract_fence_in_item, "fence-in-item");
nested_contract_test!(nested_contract_quote_in_item, "quote-in-item");
nested_contract_test!(nested_contract_table_in_item, "table-in-item");
nested_contract_test!(nested_contract_crlf, "crlf");
nested_contract_test!(nested_contract_ordered_one_space, "ordered-one-space");
nested_contract_test!(nested_contract_ordered_two_spaces, "ordered-two-spaces");
nested_contract_test!(
    nested_contract_ordered_blank_under_indent,
    "ordered-blank-under-indent"
);
nested_contract_test!(nested_contract_letter_item, "letter-item");
nested_contract_test!(nested_contract_roman_item, "roman-item");
nested_contract_test!(nested_contract_tab_item, "tab-item");
nested_contract_test!(nested_contract_tilde_fence, "tilde-fence");
nested_contract_test!(nested_contract_star_rule, "star-rule");
nested_contract_test!(nested_contract_underscore_rule, "underscore-rule");

nested_contract_test!(nested_contract_root_letter_marker, "root-letter-marker");
nested_contract_test!(nested_contract_root_roman_marker, "root-roman-marker");

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
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Original")
        .unwrap();
    let before = doc.encode_full_state();
    for source in ["- parent\n  - child\n", "1. parent\n\n   continuation\n"] {
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
fn nested_contract_encodes_first_paragraph_space() {
    let doc = Ydoc::wire();
    let fragment = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    doc.with_delta(|txn| insert_md_paragraph(txn, &fragment, 0, "  literal"));
    assert_eq!(doc.project_richdoc().unwrap(), "&#32; literal");
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
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, case["source"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            case["canonical"].as_str().unwrap()
        );
        case["rustBase64"] = json!(base64_encode(&doc.encode_full_state()));
    }
    std::fs::write(path, serde_json::to_string_pretty(&corpus).unwrap() + "\n").unwrap();
}
