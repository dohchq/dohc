//! An outside save folds only what changed into a live note (#3741).

use super::*;

fn note(blocks: usize, edit: &str) -> String {
    let mut text = String::new();
    for n in 0..blocks {
        if n > 0 {
            text.push_str("\n\n");
        }
        match n % 10 {
            0 => text.push_str(&format!("## Section {n}")),
            7 => text.push_str(&format!("- item {n} one\n- item {n} two")),
            _ => text.push_str(&format!(
                "Paragraph {n} says something ordinary about the week."
            )),
        }
        if n == blocks / 2 {
            text.push_str(edit);
        }
    }
    text.push('\n');
    text
}

fn folded(markdown: &str) -> Ydoc {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, markdown)
        .expect(markdown);
    doc
}

fn body_json(doc: &Ydoc) -> Value {
    let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let txn = doc.doc.transact();
    xml_json(&txn, XmlOut::Fragment(body))
}

/// Folds `after` over a note that held `before`, and checks the note reads
/// and is shaped exactly as a fresh fold of `after`. Returns the update.
fn fold_over(before: &str, after: &str) -> Vec<u8> {
    let doc = folded(before);
    let update = doc
        .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, after)
        .expect(after);
    let fresh = folded(after);
    assert_eq!(
        doc.project_richdoc().unwrap(),
        fresh.project_richdoc().unwrap(),
        "{before:?} -> {after:?}"
    );
    assert_eq!(
        body_json(&doc),
        body_json(&fresh),
        "{before:?} -> {after:?}"
    );
    update
}

#[test]
fn a_one_line_outside_save_costs_the_same_in_a_short_and_a_long_note() {
    let short = fold_over(&note(50, ""), &note(50, " Edited."));
    let long = fold_over(&note(500, ""), &note(500, " Edited."));
    // Replacing the whole body made the long note's update ten times the
    // short one's; now both carry one changed paragraph.
    assert!(
        long.len() <= short.len() + 16,
        "short {}, long {}",
        short.len(),
        long.len()
    );
    assert!(long.len() < 200, "long {}", long.len());
}

/// How much a note has grown: every insert it ever held, deleted ones too.
fn clock(doc: &Ydoc) -> u64 {
    let txn = doc.doc.transact();
    txn.state_vector()
        .iter()
        .map(|(_, clock)| u64::from(*clock))
        .sum()
}

#[test]
fn a_hundred_block_note_saved_often_grows_by_what_changed() {
    let doc = folded(&note(100, ""));
    let fresh = clock(&doc);
    for save in 1..=20 {
        let markdown = note(100, &format!(" Save {save}."));
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &markdown)
            .expect(&markdown);
    }
    let grown = clock(&doc) - fresh;
    // Replacing the body grew the note by all of it on every save (#3741).
    assert!(grown < fresh / 5, "fresh {fresh}, 20 saves added {grown}");
}

#[test]
fn a_block_holding_an_embedded_type_is_replaced() {
    let doc = folded("Placeholder.\n\nKept.\n");
    let text = doc.richdoc_block_text(0).unwrap();
    {
        let mut txn = doc.doc.transact_mut();
        let len = text.len(&txn);
        text.remove_range(&mut txn, 0, len);
        text.insert_embed(&mut txn, 0, yrs::ArrayPrelim::from([1, 2]));
    }
    // The block's structure spells the embed by its debug name, so a file
    // holding that name as text must still replace the block.
    let spelled = {
        let txn = doc.doc.transact();
        let delta = diffs_json(text.diff(&txn, YChange::identity));
        delta[0]["insert"].as_str().unwrap().to_owned()
    };
    let markdown = format!("{spelled}\n\nKept.\n");
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &markdown)
        .expect(&markdown);
    // The projection spells a kept embed the same way, so check the block
    // now holds the file's text rather than the embed.
    let text = doc.richdoc_block_text(0).unwrap();
    let txn = doc.doc.transact();
    let chunks = text.diff(&txn, YChange::identity);
    assert!(
        chunks
            .iter()
            .all(|chunk| matches!(chunk.insert, Out::Any(Any::String(_)))),
        "{chunks:?}"
    );
}

#[test]
fn a_body_holding_a_value_that_is_not_xml_is_replaced_whole() {
    // yrs's XML API can't hold a plain value in a body, so another type
    // writes one under the same root name.
    let source = yrs::Doc::new();
    let body = source.get_or_insert_array(ROOT_BODY);
    {
        let mut txn = source.transact_mut();
        let paragraph = body.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        paragraph.push_back(&mut txn, XmlTextPrelim::new("Kept."));
        body.push_back(&mut txn, 7);
    }
    let update = source
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let doc = Ydoc::wire();
    doc.doc
        .transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    assert_eq!(
        doc.doc
            .get_or_insert_xml_fragment(ROOT_BODY)
            .len(&doc.doc.transact()),
        2
    );
    let markdown = "Changed.\n\nKept.\n";
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, markdown)
        .expect(markdown);
    assert_eq!(body_json(&doc), body_json(&folded(markdown)));
}

#[test]
fn a_block_added_in_the_middle_costs_only_that_block() {
    let before = note(500, "");
    let after = note(500, "\n\nA new paragraph in the middle.");
    let update = fold_over(&before, &after);
    assert!(update.len() < 200, "{}", update.len());
}

#[test]
fn an_unchanged_outside_save_changes_nothing() {
    let markdown = note(50, "");
    let doc = folded(&markdown);
    let before = doc.encode_state_vector();
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &markdown)
        .unwrap();
    assert_eq!(doc.encode_state_vector(), before);
}

#[test]
fn folding_over_another_note_reads_as_a_fresh_fold() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let sources: Vec<&str> = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["fileFold"] == true)
        .map(|case| case["source"].as_str().unwrap())
        .collect();
    assert!(sources.len() > 1);
    let folds = |markdown: &str| {
        Ydoc::wire()
            .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, markdown)
            .is_ok()
    };
    let shared = "Shared paragraph.";
    let mut checked = 0;
    for pair in sources.windows(2) {
        // As they are, then with a block both share at the start, and at the end.
        let pairs = [
            (pair[0].to_owned(), pair[1].to_owned()),
            (
                format!("{shared}\n\n{}", pair[0]),
                format!("{shared}\n\n{}", pair[1]),
            ),
            (
                format!("{}\n\n{shared}\n", pair[0].trim_end()),
                format!("{}\n\n{shared}\n", pair[1].trim_end()),
            ),
        ];
        for (before, after) in pairs {
            if folds(&before) && folds(&after) {
                fold_over(&before, &after);
                checked += 1;
            }
        }
    }
    assert!(
        checked >= sources.len(),
        "{checked} of {} pairs",
        3 * (sources.len() - 1)
    );
    for (before, after) in [
        ("One.\n\nTwo.\n", "Two.\n"),
        ("Two.\n", "One.\n\nTwo.\n"),
        ("One.\n\nTwo.\n\nThree.\n", "One.\n\nThree.\n"),
        ("One.\n\nTwo.\n", "Two.\n\nOne.\n"),
    ] {
        fold_over(before, after);
    }
}

/// #3746 compared blocks as JSON. It stays here as the oracle the direct
/// comparison must agree with, or else treat the block as changed.
fn json_same<A: ReadTxn, B: ReadTxn>(old_txn: &A, old: &XmlOut, new_txn: &B, new: &XmlOut) -> bool {
    fn plain<T: ReadTxn>(txn: &T, node: &XmlOut) -> bool {
        match node {
            XmlOut::Element(element) => {
                element
                    .attributes(txn)
                    .all(|(_, value)| matches!(value, Out::Any(_)))
                    && element.children(txn).count() as u32 == element.len(txn)
                    && element.children(txn).all(|child| plain(txn, &child))
            }
            XmlOut::Text(text) => text
                .diff(txn, YChange::identity)
                .iter()
                .all(|chunk| matches!(chunk.insert, Out::Any(_))),
            XmlOut::Fragment(_) => false,
        }
    }
    plain(old_txn, old) && xml_json(old_txn, old.clone()) == xml_json(new_txn, new.clone())
}

fn blocks_of(doc: &Ydoc) -> Vec<XmlOut> {
    let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let txn = doc.doc.transact();
    body.children(&txn).collect()
}

/// A note holding `markdown` after another note was folded into it first, so
/// its blocks sit among deleted ones, as a live note's do.
fn with_history(markdown: &str) -> Option<Ydoc> {
    let doc = folded("An earlier note.\n\n- with a list\n");
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, markdown)
        .ok()?;
    Some(doc)
}

/// Compares every block of `old` with every block of `new` both ways, and
/// counts the pairs judged different and the same.
fn agree(old: &Ydoc, new: &Ydoc, tally: &mut [usize; 2]) {
    let (old_blocks, new_blocks) = (blocks_of(old), blocks_of(new));
    let (old_txn, new_txn) = (old.doc.transact(), new.doc.transact());
    for old in &old_blocks {
        for new in &new_blocks {
            let json = json_same(&old_txn, old, &new_txn, new);
            assert_eq!(
                same_xml(&old_txn, old, &new_txn, new),
                json,
                "{} vs {}",
                xml_json(&old_txn, old.clone()),
                xml_json(&new_txn, new.clone())
            );
            tally[usize::from(json)] += 1;
        }
    }
}

/// Blocks that differ from a neighbour by one thing: tag, an attribute, a
/// child, or a run's text or formatting.
const NEAR_MISSES: &[&str] = &[
    "Kept.",
    "Kept!",
    "Kept. ",
    "## Kept.",
    "### Kept.",
    "**Kept.**",
    "*Kept.*",
    "`Kept.`",
    "~~Kept.~~",
    "[Kept.](https://a.example)",
    "[Kept.](https://b.example)",
    "[Kept.](https://a.example \"title\")",
    "Kept **and** bold.",
    "Kept *and* bold.",
    "Kept **and bold.**",
    "Line one  \nline two",
    "Line one\\\nline two",
    "![Kept.](a.png)",
    "![Kept!](a.png)",
    "- Kept.",
    "- Kept.\n- Two.",
    "- Kept.\n- Too.",
    "* Kept.",
    "1. Kept.",
    "3. Kept.",
    "1. Kept.\n2. Two.",
    "- [ ] Kept.",
    "- [x] Kept.",
    "- Kept.\n  - Nested.",
    "- Kept.\n  - Nested!",
    "- Kept.\n\n  More.",
    "> Kept.",
    "> Kept!",
    "> - Kept.",
    "```\nKept.\n```",
    "```rust\nKept.\n```",
    "```ts\nKept.\n```",
    "    Kept.",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "| a | b |\n|---|---|\n| 1 | 3 |",
    "| a | b |\n|:--|--:|\n| 1 | 2 |",
    "| a | c |\n|---|---|\n| 1 | 2 |",
    "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
    "Paragraph.\n\n---",
];

#[test]
fn the_direct_comparison_decides_as_the_json_one_did() {
    let mut tally = [0, 0];
    // Every near miss against every other, each from a note with history
    // against a fresh fold.
    let fresh: Vec<Ydoc> = NEAR_MISSES
        .iter()
        .map(|markdown| folded(&format!("{markdown}\n")))
        .collect();
    for old in NEAR_MISSES {
        let old = with_history(&format!("{old}\n")).expect(old);
        for new in &fresh {
            agree(&old, new, &mut tally);
        }
    }
    // Every Markdown contract source that folds, against itself and the
    // next two.
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-markdown-contract.json"
    ))
    .unwrap();
    let pairs: Vec<(Ydoc, Ydoc)> = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|case| {
            let source = case["source"].as_str().unwrap();
            let fresh = Ydoc::wire();
            fresh
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
                .ok()?;
            Some((with_history(source)?, fresh))
        })
        .collect();
    assert!(pairs.len() > 100, "{} sources fold", pairs.len());
    for (index, (old, _)) in pairs.iter().enumerate() {
        for (_, new) in pairs.iter().skip(index).take(3) {
            agree(old, new, &mut tally);
        }
    }
    let [different, same] = tally;
    assert!(same > NEAR_MISSES.len() + pairs.len(), "same {same}");
    assert!(different > same, "different {different}, same {same}");
}

#[test]
fn the_direct_comparison_treats_what_json_cannot_tell_apart_as_changed() {
    // A heading's level, a number either way, stored as the other kind.
    let fresh = folded("## Kept.\n");
    let old = folded("## Kept.\n");
    let XmlOut::Element(heading) = blocks_of(&old).remove(0) else {
        panic!("not a heading")
    };
    {
        let mut txn = old.doc.transact_mut();
        let other = match heading.get_attribute(&txn, "level") {
            Some(Out::Any(Any::Number(level))) => Any::BigInt(level as i64),
            Some(Out::Any(Any::BigInt(level))) => Any::Number(level as f64),
            level => panic!("{level:?}"),
        };
        heading.insert_attribute(&mut txn, "level", other);
    }
    let (old_block, new_block) = (blocks_of(&old).remove(0), blocks_of(&fresh).remove(0));
    let (old_txn, new_txn) = (old.doc.transact(), fresh.doc.transact());
    // JSON spells both the same; the direct comparison keeps nothing.
    assert!(json_same(&old_txn, &old_block, &new_txn, &new_block));
    assert!(!same_xml(&old_txn, &old_block, &new_txn, &new_block));
}

#[test]
fn the_direct_comparison_never_keeps_a_block_holding_a_shared_type_or_value() {
    // Each block is compared with itself, so only what it holds can make
    // either comparison call it changed.
    // A paragraph with a plain number among its children.
    let child = folded("Kept.\n");
    let XmlOut::Element(paragraph) = blocks_of(&child).remove(0) else {
        panic!("not a paragraph")
    };
    {
        let mut txn = child.doc.transact_mut();
        let branch = yrs::branch::BranchPtr::from(paragraph.as_ref());
        yrs::ArrayRef::from(branch).push_back(&mut txn, 7);
    }
    // A heading whose level is a shared array.
    let attribute = folded("## Kept.\n");
    let XmlOut::Element(element) = blocks_of(&attribute).remove(0) else {
        panic!("not a heading")
    };
    {
        let mut txn = attribute.doc.transact_mut();
        element.insert_attribute(&mut txn, "level", yrs::ArrayPrelim::from([2]));
    }
    // A paragraph whose text is an embedded array.
    let embed = folded("Kept.\n");
    let text = embed.richdoc_block_text(0).unwrap();
    {
        let mut txn = embed.doc.transact_mut();
        let len = text.len(&txn);
        text.remove_range(&mut txn, 0, len);
        text.insert_embed(&mut txn, 0, yrs::ArrayPrelim::from([1, 2]));
    }
    for doc in [&child, &attribute, &embed] {
        let block = blocks_of(doc).remove(0);
        let txn = doc.doc.transact();
        assert!(!json_same(&txn, &block, &txn, &block));
        assert!(!same_xml(&txn, &block, &txn, &block));
    }
}
