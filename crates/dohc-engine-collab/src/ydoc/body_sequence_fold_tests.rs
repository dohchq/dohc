use super::body_sequence::tests::{same_document, shown};
use super::*;
use base64::Engine as _;

const FOLDS: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-folds.json");

#[derive(serde::Deserialize)]
struct Fold {
    name: String,
    before: String,
    file: String,
    after: After,
}

#[derive(serde::Deserialize)]
struct After {
    document: serde_json::Value,
    markdown: String,
}

fn note(before: &str) -> Ydoc {
    let doc = Ydoc::wire();
    let update = base64::engine::general_purpose::STANDARD
        .decode(before)
        .expect("base64");
    doc.apply(&update).expect("the note applies");
    doc
}

fn reading(doc: &Ydoc) -> Result<(serde_json::Value, String), CollabError> {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
    let read = {
        let txn = doc.doc.transact();
        body_sequence::blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes)?
    };
    let document = serde_json::json!({ "type": "doc", "content": shown(&read) });
    Ok((document, doc.project(ContentKind::Richdoc)?.content))
}

fn folded(fold: &Fold) -> Result<(serde_json::Value, String), CollabError> {
    let doc = note(&fold.before);
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &fold.file)?;
    reading(&doc)
}

#[test]
fn each_shared_fold_reads_as_its_document_after() {
    let folds = shared_folds();
    let mut differing = Vec::new();
    reading_body_sequence_here(|| {
        for fold in &folds {
            match folded(fold) {
                Ok((document, markdown))
                    if same_document(&fold.after.document, &document)
                        && markdown == fold.after.markdown => {}
                Ok((document, markdown)) => {
                    differing.push(format!("{}: read {document} as {markdown:?}", fold.name))
                }
                Err(error) => differing.push(format!("{}: {error:?}", fold.name)),
            }
        }
    });
    assert_eq!(folds.len(), 27);
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}

fn shared_folds() -> Vec<Fold> {
    serde_json::from_str(FOLDS).expect("the shared folds")
}

#[test]
fn an_outside_save_format_two_cannot_hold_keeps_its_file_as_the_source() {
    let file = "Run [`npm install`](https://example.com) first\n";
    reading_body_sequence_here(|| {
        let doc = note(&shared_folds()[0].before);
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
            .expect("the nearest reading");
        let projection = doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(projection, "Run `npm install` first\n");
        doc.preserve_folded_markdown_source(file)
            .expect("the source");
        assert_eq!(doc.note_schema_version(), 2);
        assert_eq!(
            doc.settled_markdown_source(&projection, || Ok::<_, ()>(Some(file.to_owned())))
                .unwrap()
                .as_deref(),
            Some(file)
        );
    });
}

#[test]
fn a_format_two_note_takes_new_frontmatter_without_a_new_body() {
    reading_body_sequence_here(|| {
        let fold = &shared_folds()[0];
        let doc = note(&fold.before);
        let (_, before) = reading(&doc).unwrap();
        let file = format!("---\ntitle: A\n---\n\n{before}");
        doc.replace_frontmatter_for_fold(&file)
            .expect("frontmatter");
        assert_eq!(doc.note_schema_version(), 2);
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, file);
    });
}

const LINES: usize = 10_000;

fn numbered(line: usize) -> String {
    format!("{line:0>59}a")
}

fn long_note(line: impl Fn(usize) -> String) -> Vec<String> {
    (0..LINES).map(line).collect()
}

fn markdown(lines: &[String]) -> String {
    format!("{}\n", lines.join("\n\n"))
}

enum Bar {
    Runs { runs: usize, lines: usize },
    Whole,
}

fn brake_cases() -> Vec<(&'static str, String, Bar)> {
    let note = long_note(numbered);
    let edited = |edit: &dyn Fn(&mut Vec<String>)| {
        let mut lines = note.clone();
        edit(&mut lines);
        markdown(&lines)
    };
    let runs = |lines| Bar::Runs { runs: 1, lines };
    vec![
        (
            "one letter",
            edited(&|lines| lines[LINES / 2].push('b')),
            runs(0),
        ),
        (
            "a line at the top",
            edited(&|lines| lines.insert(0, "new".into())),
            runs(1),
        ),
        (
            "a join",
            edited(&|lines| {
                let below = lines.remove(LINES / 2 + 1);
                lines[LINES / 2].push_str(&below);
            }),
            runs(0),
        ),
        (
            "an edit at line 1",
            edited(&|lines| lines[0].insert(0, 'b')),
            runs(0),
        ),
        (
            "an edit at the last line",
            edited(&|lines| lines[LINES - 1].push('b')),
            runs(0),
        ),
        (
            "the whole file replaced",
            markdown(&long_note(|line| format!("{line:z<60}"))),
            Bar::Whole,
        ),
    ]
}

const CLIENTS: [u64; 3] = [
    0x1A_2B3C_4D5E_6F70,
    0x1A_2B3C_4D5E_6F71,
    0x1A_2B3C_4D5E_6F72,
];

fn seeded(format: u8, file: &str) -> Ydoc {
    let doc = Ydoc::with_client_id(CLIENTS[0]);
    if format == 2 {
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        meta.insert(
            &mut doc.doc.transact_mut(),
            "schemaVersion",
            Any::Number(2.0),
        );
    }
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
        .expect("the seed");
    doc
}

fn copy(doc: &Ydoc, client: u64) -> Ydoc {
    let copy = Ydoc::with_client_id(client);
    copy.apply(&doc.encode_full_state()).expect("the copy");
    copy
}

fn sequence_length(doc: &Ydoc) -> usize {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let length = sequence.len(&doc.doc.transact());
    length as usize
}

#[test]
fn a_fold_of_a_long_note_does_work_and_writes_bytes_in_proportion_to_its_change() {
    reading_body_sequence_here(|| {
        let file = markdown(&long_note(numbered));
        let (one, two) = (seeded(1, &file), seeded(2, &file));
        let boundary = {
            let note = seeded(2, "a\n");
            let fold = |file: &str| {
                copy(&note, CLIENTS[1])
                    .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
                    .expect("a small fold")
                    .len()
            };
            fold("a\n\nb\n") - fold("ab\n")
        };
        let mut over = Vec::new();
        for (name, edited, bar) in brake_cases() {
            let format_one = copy(&one, CLIENTS[1])
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &edited)
                .expect("format 1")
                .len();
            let doc = copy(&two, CLIENTS[1]);
            let before = sequence_length(&doc);
            body_sequence_fold::SLOTS_VISITED.with(|visited| visited.set(0));
            let format_two = doc
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &edited)
                .expect("format 2")
                .len();
            let visited = body_sequence_fold::SLOTS_VISITED.with(std::cell::Cell::get);
            let allowed = 2 * (before + sequence_length(&doc));
            assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, edited);
            let bytes = match bar {
                Bar::Runs { runs, lines } => format_one * 11 / 10 + 16 * runs + boundary * lines,
                Bar::Whole => format_one * 13 / 10,
            };
            if visited > allowed || format_two > bytes {
                over.push(format!(
                    "{name}: {visited} slots of {allowed}, {format_two} bytes of {bytes} beside {format_one}"
                ));
            }
        }
        assert!(over.is_empty(), "{}", over.join("\n"));
    });
}

#[test]
fn a_fold_keeps_the_letters_a_peer_is_typing_into() {
    let note = "one\n\ntwo\n\nthree\n";
    reading_body_sequence_here(|| {
        for (folded, typed, merged) in [
            (
                "two\n\nthree\n",
                "one\n\ntwoX\n\nthree\n",
                "twoX\n\nthree\n",
            ),
            (
                "one\n\nTWO\n\nthree\n",
                "one\n\ntwo\n\nthreeX\n",
                "one\n\nTWO\n\nthreeX\n",
            ),
            (
                "one\n\n- two\n\nthree\n",
                "one\n\ntwo\n\nXthree\n",
                "one\n\n- two\n\nXthree\n",
            ),
        ] {
            let base = seeded(2, note);
            let (ours, theirs) = (copy(&base, CLIENTS[1]), copy(&base, CLIENTS[2]));
            let ours_update = ours
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, folded)
                .expect("our fold");
            let theirs_update = theirs
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, typed)
                .expect("their typing");
            ours.apply(&theirs_update).unwrap();
            theirs.apply(&ours_update).unwrap();
            for doc in [&ours, &theirs] {
                assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, merged);
            }
        }
    });
}

fn edited(doc: &Ydoc, edit: impl FnOnce(&mut yrs::TransactionMut, &yrs::TextRef, &MapRef)) {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    edit(&mut doc.doc.transact_mut(), &sequence, &containers);
}

fn by_hand(write: impl FnOnce(&mut yrs::TransactionMut, &yrs::TextRef, &MapRef)) -> Ydoc {
    let doc = Ydoc::with_client_id(CLIENTS[0]);
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    meta.insert(
        &mut doc.doc.transact_mut(),
        "schemaVersion",
        Any::Number(2.0),
    );
    edited(&doc, write);
    doc
}

fn line(txn: &mut yrs::TransactionMut, sequence: &yrs::TextRef, kind: &str, path: &[&str]) {
    let at = sequence.len(txn);
    let stored = sequence.insert_embed(txn, at, XmlElementPrelim::empty(body_sequence::BOUNDARY));
    let path: Vec<Any> = path.iter().map(|id| Any::from(*id)).collect();
    stored.insert_attribute(txn, "type", Any::from(kind));
    stored.insert_attribute(txn, "path", Any::from(path));
}

fn typed(txn: &mut yrs::TransactionMut, sequence: &yrs::TextRef, letters: &str) {
    let at = sequence.len(txn);
    sequence.insert(txn, at, letters);
}

fn marked(name: &str, value: Any) -> yrs::types::Attrs {
    yrs::types::Attrs::from([(Arc::from(name), value)])
}

fn bold() -> Any {
    Any::from(HashMap::<String, Any>::new())
}

fn boundaries(doc: &Ydoc) -> Vec<yrs::XmlElementRef> {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let mut found = Vec::new();
    let _ = sequence.try_visit_items(&doc.doc.transact(), |item| {
        if let yrs::types::text::TextItem::Embed(Out::YXmlElement(element)) = item {
            if element.tag().as_ref() == body_sequence::BOUNDARY {
                found.push(element);
            }
        }
        Ok::<_, ()>(())
    });
    found
}

fn path_of(doc: &Ydoc, line: usize) -> Vec<String> {
    let element = boundaries(doc).swap_remove(line);
    let _reading = doc.doc.transact();
    match body_sequence::stored_under(&element, "path") {
        Some(Any::Array(ids)) => ids
            .iter()
            .map(|id| match id {
                Any::String(id) => id.to_string(),
                _ => String::new(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn record(doc: &Ydoc, key: &str) -> Option<Any> {
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    let _reading = doc.doc.transact();
    body_sequence::stored_under(&containers, key)
}

fn markdown_of(doc: &Ydoc) -> String {
    doc.project(ContentKind::Richdoc).unwrap().content
}

fn fold(doc: &Ydoc, file: &str) {
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
        .expect("the fold");
}

fn merged(ours: &Ydoc, theirs: &Ydoc) -> [String; 2] {
    let (our_state, their_state) = (ours.encode_full_state(), theirs.encode_full_state());
    ours.apply(&their_state).unwrap();
    theirs.apply(&our_state).unwrap();
    [markdown_of(ours), markdown_of(theirs)]
}

fn peers(base: &Ydoc) -> (Ydoc, Ydoc) {
    (copy(base, CLIENTS[1]), copy(base, CLIENTS[2]))
}

#[test]
fn a_fold_keeps_code_letters_whose_marks_the_code_block_hides() {
    reading_body_sequence_here(|| {
        let base = by_hand(|txn, sequence, _| {
            line(txn, sequence, "codeBlock", &[]);
            sequence.insert_with_attributes(txn, 1, "ab", marked("bold", bold()));
        });
        let code = "```\nab\n```\n";
        assert_eq!(markdown_of(&base), code);
        let (ours, theirs) = peers(&base);
        fold(&ours, &format!("{code}\nmore\n"));
        edited(&theirs, |txn, sequence, _| sequence.remove_range(txn, 2, 1));
        let after = "```\na\n```\n\nmore\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
    });
}

#[test]
fn a_new_line_above_a_line_leaves_that_line_its_boundary() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "# Title\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "Above\n\n# Title\n");
        let title = boundaries(&theirs).swap_remove(0);
        edited(&theirs, move |txn, _, _| {
            title.insert_attribute(txn, "level", Any::Number(2.0));
        });
        let after = "Above\n\n## Title\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
    });
}

#[test]
fn a_line_split_inside_bold_letters_writes_no_formatting_a_peer_must_undo() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "**ab**\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "**a**\n\n**b**\n");
        edited(&theirs, |txn, sequence, _| {
            sequence.format(txn, 1, 2, marked("bold", Any::Null))
        });
        let after = "a\n\nb\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
    });
}

fn a_bullet_that_was_a_task(lines: &'static [&'static str]) -> Ydoc {
    by_hand(move |txn, sequence, containers| {
        containers.insert(txn, "l", Any::from("bulletList"));
        containers.insert(txn, "i", Any::from("listItem"));
        containers.insert(txn, "i.checked", Any::Bool(true));
        for letters in lines {
            line(txn, sequence, "paragraph", &["l", "i"]);
            typed(txn, sequence, letters);
        }
    })
}

#[test]
fn a_fold_keeps_the_records_a_list_item_holds_for_another_kind() {
    reading_body_sequence_here(|| {
        let base = a_bullet_that_was_a_task(&["a"]);
        assert_eq!(markdown_of(&base), "- a\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "- ab\n");
        edited(&theirs, |txn, _, containers| {
            containers.insert(txn, "l", Any::from("taskList"));
            containers.insert(txn, "i", Any::from("taskItem"));
        });
        let after = "- [x] ab\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
        assert_eq!(path_of(&ours, 0), ["l", "i"]);

        let split = a_bullet_that_was_a_task(&["a", "b"]);
        assert_eq!(markdown_of(&split), "- a\n\n  b\n");
        fold(&split, "- a\n- b\n");
        let copied = path_of(&split, 1).swap_remove(1);
        assert_ne!(copied, "i");
        for item in ["i", copied.as_str()] {
            let checked = record(&split, &format!("{item}.checked"));
            assert_eq!(checked, Some(Any::Bool(true)), "{item}");
        }
    });
}

#[test]
fn a_wrap_keeps_the_ids_of_the_list_it_wraps() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "- a\n");
        let ids = path_of(&base, 0);
        let list = ids[0].clone();
        let (ours, theirs) = peers(&base);
        fold(&ours, "> - a\n");
        edited(&theirs, move |txn, _, containers| {
            containers.insert(txn, list, Any::from("orderedList"));
        });
        let after = "> 1. a\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
        assert_eq!(path_of(&ours, 0)[1..], ids);
    });
}

#[test]
fn a_frontmatter_only_save_gives_no_line_a_boundary() {
    reading_body_sequence_here(|| {
        let doc = by_hand(|txn, sequence, _| {
            line(txn, sequence, "codeBlock", &[]);
            typed(txn, sequence, "code");
            let at = sequence.len(txn);
            let image = sequence.insert_embed(txn, at, XmlElementPrelim::empty("image"));
            image.insert_attribute(txn, "src", Any::from("b.png"));
            image.insert_attribute(txn, "alt", Any::from("a"));
        });
        let body = markdown_of(&doc);
        assert_eq!(body, "```\ncode\n```\n\n![a](b.png)\n");
        let length = sequence_length(&doc);
        let file = format!("---\ntitle: A\n---\n\n{body}");
        fold(&doc, &file);
        assert_eq!(markdown_of(&doc), file);
        assert_eq!(sequence_length(&doc), length);
    });
}

#[test]
fn deleting_a_line_leaves_the_next_line_its_boundary() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "- [ ] one\n- [ ] two\n- [ ] three\n");
        let two = path_of(&base, 1);
        let item = two[1].clone();
        let (ours, theirs) = peers(&base);
        fold(&ours, "- [ ] two\n- [ ] three\n");
        edited(&theirs, move |txn, _, containers| {
            containers.insert(txn, format!("{item}.checked"), Any::Bool(true));
        });
        let after = "- [x] two\n- [ ] three\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
        assert_eq!(path_of(&ours, 0), two);

        let base = seeded(2, "Above\n\n# Title\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "# Title\n");
        let title = boundaries(&theirs).pop().unwrap();
        edited(&theirs, move |txn, _, _| {
            title.insert_attribute(txn, "level", Any::Number(2.0));
        });
        assert_eq!(merged(&ours, &theirs), ["## Title\n", "## Title\n"]);

        let base = seeded(2, "alpha\n\n# atlas\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "# atlas\n");
        edited(&theirs, |txn, sequence, _| {
            let at = sequence.len(txn) - 5;
            sequence.remove_range(txn, at, 1);
        });
        assert_eq!(merged(&ours, &theirs), ["# tlas\n", "# tlas\n"]);
    });
}

fn bold_code() -> Ydoc {
    by_hand(|txn, sequence, _| {
        typed(txn, sequence, "x");
        line(txn, sequence, "codeBlock", &[]);
        let at = sequence.len(txn);
        sequence.insert_with_attributes(txn, at, "ab", marked("bold", bold()));
    })
}

#[test]
fn code_letters_that_leave_their_code_block_lose_the_marks_it_hid() {
    reading_body_sequence_here(|| {
        assert_eq!(markdown_of(&bold_code()), "x\n\n```\nab\n```\n");
        for file in ["x\n\nab\n", "xab\n"] {
            let doc = bold_code();
            fold(&doc, file);
            assert_eq!(markdown_of(&doc), file);
        }
    });
}

#[test]
fn a_formatting_only_save_keeps_a_peer_delete() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "ab\n");
        let (ours, theirs) = peers(&base);
        let length = sequence_length(&ours);
        fold(&ours, "**ab**\n");
        assert_eq!(sequence_length(&ours), length);
        edited(&theirs, |txn, sequence, _| {
            let at = sequence.len(txn) - 1;
            sequence.remove_range(txn, at, 1);
        });
        assert_eq!(merged(&ours, &theirs), ["**a**\n", "**a**\n"]);
    });
}

#[test]
fn an_element_that_replaces_bold_letters_writes_no_formatting_a_peer_must_undo() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "**ab**\n");
        let (ours, theirs) = peers(&base);
        fold(&ours, "![a](b.png)**b**\n");
        edited(&theirs, |txn, sequence, _| {
            let at = sequence.len(txn) - 2;
            sequence.format(txn, at, 2, marked("bold", Any::Null))
        });
        let after = "![a](b.png)b\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
    });
}

#[test]
fn a_path_never_holds_one_id_twice() {
    reading_body_sequence_here(|| {
        let doc = by_hand(|txn, sequence, containers| {
            containers.insert(txn, "q", Any::from("blockquote"));
            containers.insert(txn, "l", Any::from("bulletList"));
            containers.insert(txn, "i", Any::from("listItem"));
            line(txn, sequence, "paragraph", &["q"]);
            typed(txn, sequence, "a");
            line(txn, sequence, "paragraph", &["l", "i", "q"]);
            typed(txn, sequence, "c");
        });
        assert_eq!(markdown_of(&doc), "> a\n\n- \n  > c\n");
        let file = "> a\n>\n> - \n>   > c\n";
        fold(&doc, file);
        assert_eq!(markdown_of(&doc), markdown_of(&seeded(2, file)));
        let path = path_of(&doc, boundaries(&doc).len() - 1);
        assert_eq!(path.len(), 4, "{path:?}");
        assert_eq!(path[1..3], ["l", "i"]);
        assert_eq!(path.iter().collect::<BTreeSet<_>>().len(), 4, "{path:?}");
    });
}

#[test]
fn another_replica_writes_the_file_a_format_two_note_took_as_its_source() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "Run it first\n");
        let (ours, theirs) = peers(&base);
        let file = "Run [`npm install`](https://example.com) first\n";
        fold(&ours, file);
        ours.preserve_folded_markdown_source(file).unwrap();
        theirs.apply(&ours.encode_full_state()).unwrap();
        let projection = markdown_of(&theirs);
        assert_ne!(projection, file);
        let snapshot = || Ok::<_, ()>(Some("Run it first\n".to_owned()));
        let source = theirs.settled_markdown_source(&projection, snapshot);
        assert_eq!(source, Ok(Some(file.to_owned())));
    });
}

#[test]
fn merging_two_quotes_keeps_the_ids_of_a_list_in_the_second() {
    reading_body_sequence_here(|| {
        let base = seeded(2, "> a\n\nmiddle\n\n> - b\n");
        let last = boundaries(&base).len() - 1;
        let ids = path_of(&base, last)[1..].to_vec();
        let list = ids[0].clone();
        let (ours, theirs) = peers(&base);
        fold(&ours, "> a\n>\n> middle\n>\n> - b\n");
        edited(&theirs, move |txn, _, containers| {
            containers.insert(txn, list, Any::from("orderedList"));
        });
        let after = "> a\n>\n> middle\n>\n> 1. b\n";
        assert_eq!(merged(&ours, &theirs), [after, after]);
        assert_eq!(path_of(&ours, last)[1..], ids);
    });
}
