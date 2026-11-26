use super::*;
use crate::StructuralHold::{
    ExistingParentKey, ExistingTextFormat, HiddenContent, LiveDeletion, UnprovenDeletion,
};
use crate::UpdateInspection::{Admissible, Hold};
use crate::{inspect_update, UpdateInspection};
use yrs::{TextRef, TransactionMut, XmlElementRef};

const SEED: u64 = 0x1A_0000_0001;
const AHEAD: u64 = 0x1A_0000_0002;
const LATE: u64 = 0x1A_0000_0003;

fn marked_note(client: u64) -> Ydoc {
    let doc = Ydoc::with_client_id(client);
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    meta.insert(
        &mut doc.doc.transact_mut(),
        "schemaVersion",
        Any::Number(2.0),
    );
    doc
}

fn note(file: &str) -> Ydoc {
    let doc = marked_note(SEED);
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
        .expect("the seed");
    doc
}

fn by_hand(write: impl FnOnce(&mut TransactionMut, &TextRef, &MapRef)) -> Ydoc {
    let doc = marked_note(SEED);
    edit(&doc, write);
    doc
}

fn line(txn: &mut TransactionMut, sequence: &TextRef, kind: &str, path: &[&str]) -> XmlElementRef {
    let at = sequence.len(txn);
    let stored = sequence.insert_embed(txn, at, XmlElementPrelim::empty(body_sequence::BOUNDARY));
    let path: Vec<Any> = path.iter().map(|id| Any::from(*id)).collect();
    stored.insert_attribute(txn, "type", Any::from(kind));
    stored.insert_attribute(txn, "path", Any::from(path));
    stored
}

fn typed(txn: &mut TransactionMut, sequence: &TextRef, letters: &str) {
    let at = sequence.len(txn);
    sequence.insert(txn, at, letters);
}

fn bold() -> yrs::types::Attrs {
    yrs::types::Attrs::from([(Arc::from("bold"), Any::from(HashMap::<String, Any>::new()))])
}

fn copy(doc: &Ydoc, client: u64) -> Ydoc {
    let copy = Ydoc::with_client_id(client);
    copy.apply(&doc.encode_full_state()).expect("the copy");
    copy
}

fn head(docs: &[&Ydoc]) -> Ydoc {
    let head = Ydoc::wire();
    for doc in docs {
        head.apply(&doc.encode_full_state()).expect("the head");
    }
    head
}

fn edit(doc: &Ydoc, write: impl FnOnce(&mut TransactionMut, &TextRef, &MapRef)) -> Vec<u8> {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    let before = doc.doc.transact().state_vector();
    write(&mut doc.doc.transact_mut(), &sequence, &containers);
    doc.doc.transact().encode_state_as_update_v1(&before)
}

fn edited(
    base: &Ydoc,
    write: impl FnOnce(&mut TransactionMut, &TextRef, &MapRef),
) -> UpdateInspection {
    inspect_update(&head(&[base]), &edit(&copy(base, LATE), write))
}

fn folded(base: &Ydoc, file: &str) -> UpdateInspection {
    let update = copy(base, LATE)
        .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
        .expect("the fold");
    inspect_update(&head(&[base]), &update)
}

fn boundaries(doc: &Ydoc) -> Vec<XmlElementRef> {
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

fn boundary_writing(
    line: usize,
    attributes: Vec<(&'static str, Any)>,
) -> impl FnOnce(&mut TransactionMut, &TextRef, &MapRef) {
    move |txn, sequence, _| {
        let mut found = Vec::new();
        let _ = sequence.try_visit_items(&*txn, |item| {
            if let yrs::types::text::TextItem::Embed(Out::YXmlElement(element)) = item {
                found.push(element);
            }
            Ok::<_, ()>(())
        });
        let boundary = found.swap_remove(line);
        for (key, value) in attributes {
            boundary.insert_attribute(txn, key, value);
        }
    }
}

fn varint(mut value: u64, into: &mut Vec<u8>) {
    while value >= 0x80 {
        into.push((value as u8 & 0x7F) | 0x80);
        value >>= 7;
    }
    into.push(value as u8);
}

fn deleting_only(element: &XmlElementRef) -> Vec<u8> {
    let yrs::branch::BranchID::Nested(id) = AsRef::<yrs::branch::Branch>::as_ref(element).id()
    else {
        panic!("a nested element");
    };
    let mut update = vec![0, 1];
    varint(id.client.get(), &mut update);
    update.push(1);
    varint(u64::from(id.clock), &mut update);
    update.push(1);
    update
}

#[test]
fn a_released_format_two_note_takes_marks_joins_and_records() {
    reading_body_sequence_here(|| {
        let letters = note("ab\n");
        assert_eq!(
            edited(&letters, |txn, sequence, _| sequence.format(
                txn,
                1,
                2,
                bold()
            )),
            Admissible
        );
        let lines = note("a\n\nb\n");
        assert_eq!(
            edited(&lines, |txn, sequence, _| sequence.remove_range(txn, 2, 1)),
            Admissible
        );
        let task = |checked: Option<bool>| {
            by_hand(move |txn, sequence, containers| {
                containers.insert(txn, "l", Any::from("taskList"));
                containers.insert(txn, "i", Any::from("taskItem"));
                if let Some(checked) = checked {
                    containers.insert(txn, "i.checked", Any::Bool(checked));
                }
                line(txn, sequence, "paragraph", &["l", "i"]);
                typed(txn, sequence, "a");
            })
        };
        for checked in [None, Some(false)] {
            let tick = |txn: &mut TransactionMut, _: &TextRef, containers: &MapRef| {
                containers.insert(txn, "i.checked", Any::Bool(true));
            };
            assert_eq!(edited(&task(checked), tick), Admissible, "{checked:?}");
        }
        let heading = note("# a\n");
        assert_eq!(
            edited(
                &heading,
                boundary_writing(0, vec![("level", Any::Number(2.0))])
            ),
            Admissible
        );
    });
}

#[test]
fn a_released_format_two_note_takes_the_writers_ordinary_edits() {
    reading_body_sequence_here(|| {
        let mut differing = Vec::new();
        for (before, after) in [
            ("**ab**\n", "**a**\n\n**b**\n"),
            ("a\n", "> a\n"),
            ("a\n\n---\n", "a\n\n$$x$$\n"),
            ("- a\n", "- a\n- b\n"),
            ("- a\n- b\n", "- a\n  - b\n"),
            ("| h |\n| --- |\n| v |\n", "| h |\n| --- |\n| v |\n| w |\n"),
            ("3. a\n", "5. a\n"),
            ("[a](https://example.com)\n", "a\n"),
            ("> a\n", "a\n"),
        ] {
            let decided = folded(&note(before), after);
            if decided != Admissible {
                differing.push(format!("{before:?} to {after:?}: {decided:?}"));
            }
        }
        assert!(differing.is_empty(), "{}", differing.join("\n"));
    });
}

#[test]
fn a_released_format_two_note_holds_deleted_letters() {
    reading_body_sequence_here(|| {
        let letters = note("ab\n");
        assert_eq!(
            edited(&letters, |txn, sequence, _| sequence
                .remove_range(txn, 1, 1)),
            Hold(LiveDeletion)
        );
        let lines = note("a\n\nb\n");
        assert_eq!(
            edited(&lines, |txn, sequence, _| sequence.remove_range(txn, 1, 2)),
            Hold(LiveDeletion)
        );
    });
}

#[test]
fn a_deletion_running_past_the_head_holds_on_its_unknown_part() {
    reading_body_sequence_here(|| {
        let base = by_hand(|txn, sequence, _| {
            line(txn, sequence, "paragraph", &[]);
            typed(txn, sequence, "a");
            line(txn, sequence, "paragraph", &[]);
        });
        let same = copy(&base, SEED);
        let sequence = same.doc.get_or_insert_text(ROOT_SEQUENCE);
        typed(&mut same.doc.transact_mut(), &sequence, "c");
        let update = edit(&same, |txn, sequence, _| sequence.remove_range(txn, 2, 2));
        assert_eq!(
            inspect_update(&head(&[&base]), &update),
            Hold(UnprovenDeletion)
        );
    });
}

fn math_after_a_line() -> Ydoc {
    by_hand(|txn, sequence, _| {
        line(txn, sequence, "paragraph", &[]);
        typed(txn, sequence, "a");
        let math = line(txn, sequence, "mathBlock", &[]);
        math.insert_attribute(txn, "tex", Any::from("x"));
    })
}

#[test]
fn a_released_format_two_note_holds_a_hidden_formula() {
    reading_body_sequence_here(|| {
        let base = math_after_a_line();
        let math = boundaries(&base).swap_remove(1);
        assert_eq!(
            inspect_update(&head(&[&base]), &deleting_only(&math)),
            Hold(HiddenContent)
        );
        assert_eq!(
            edited(
                &base,
                boundary_writing(1, vec![("type", Any::from("paragraph"))])
            ),
            Hold(HiddenContent)
        );
        let rule = note("a\n\n---\n");
        let ahead = copy(&rule, AHEAD);
        edit(
            &ahead,
            boundary_writing(
                1,
                vec![("type", Any::from("mathBlock")), ("tex", Any::from("x"))],
            ),
        );
        let join = edit(&copy(&rule, LATE), |txn, sequence, _| {
            sequence.remove_range(txn, 2, 1)
        });
        assert_eq!(
            inspect_update(&head(&[&rule, &ahead]), &join),
            Hold(HiddenContent)
        );
    });
}

fn titled_callout(above: bool) -> Ydoc {
    by_hand(move |txn, sequence, containers| {
        containers.insert(txn, "c", Any::from("callout"));
        containers.insert(txn, "c.title", Any::from("T"));
        if above {
            line(txn, sequence, "paragraph", &[]);
            typed(txn, sequence, "a");
        }
        line(txn, sequence, "paragraph", &["c"]);
        typed(txn, sequence, "b");
    })
}

#[test]
fn a_released_format_two_note_holds_a_hidden_callout_title() {
    reading_body_sequence_here(|| {
        let callout = titled_callout(false);
        assert_eq!(
            edited(&callout, |txn, _, containers| {
                containers.insert(txn, "c", Any::from("blockquote"));
            }),
            Hold(HiddenContent)
        );
        let below = titled_callout(true);
        assert_eq!(
            edited(&below, |txn, sequence, _| sequence.remove_range(txn, 2, 1)),
            Hold(HiddenContent)
        );
        let ahead = copy(&callout, AHEAD);
        edit(&ahead, |txn, _, containers| {
            containers.insert(txn, "c.title", Any::from("U"));
        });
        let late = edit(&copy(&callout, LATE), |txn, _, containers| {
            containers.insert(txn, "c.title", Any::from("V"));
        });
        assert_eq!(
            inspect_update(&head(&[&callout, &ahead]), &late),
            Hold(HiddenContent)
        );
    });
}

#[test]
fn a_released_format_two_note_holds_what_it_cannot_read_again() {
    reading_body_sequence_here(|| {
        let ordered = by_hand(|txn, sequence, containers| {
            containers.insert(txn, "o", Any::from("orderedList"));
            containers.insert(txn, "o.start", Any::Number(3.0));
            containers.insert(txn, "i", Any::from("listItem"));
            line(txn, sequence, "paragraph", &["o", "i"]);
            typed(txn, sequence, "a");
        });
        assert_eq!(
            edited(&ordered, |txn, _, containers| {
                containers.remove(txn, "o.start");
            }),
            Hold(LiveDeletion)
        );

        let forged = by_hand(|txn, sequence, _| {
            line(txn, sequence, "paragraph", &[]);
            typed(txn, sequence, "a");
        });
        let body = forged.doc.get_or_insert_xml_fragment(ROOT_BODY);
        body.insert(
            &mut forged.doc.transact_mut(),
            0,
            XmlElementPrelim::empty(body_sequence::BOUNDARY),
        );
        let removed = {
            let peer = copy(&forged, LATE);
            let body = peer.doc.get_or_insert_xml_fragment(ROOT_BODY);
            let before = peer.doc.transact().state_vector();
            body.remove_range(&mut peer.doc.transact_mut(), 0, 1);
            let after = peer.doc.transact();
            after.encode_state_as_update_v1(&before)
        };
        assert_eq!(
            inspect_update(&head(&[&forged]), &removed),
            Hold(LiveDeletion)
        );

        let keyed = marked_note(SEED);
        let sequence = keyed.doc.get_or_insert_map(ROOT_SEQUENCE);
        sequence.insert(
            &mut keyed.doc.transact_mut(),
            "k",
            XmlElementPrelim::empty(body_sequence::BOUNDARY),
        );
        let keyed_edit = |write: fn(&mut TransactionMut, &MapRef)| {
            let peer = copy(&keyed, LATE);
            let sequence = peer.doc.get_or_insert_map(ROOT_SEQUENCE);
            let before = peer.doc.transact().state_vector();
            write(&mut peer.doc.transact_mut(), &sequence);
            let update = peer.doc.transact().encode_state_as_update_v1(&before);
            inspect_update(&head(&[&keyed]), &update)
        };
        assert_eq!(
            keyed_edit(|txn, sequence| {
                sequence.insert(txn, "j", Any::Number(1.0));
            }),
            Hold(ExistingParentKey)
        );
        assert_eq!(
            keyed_edit(|txn, sequence| {
                sequence.remove(txn, "k");
            }),
            Hold(LiveDeletion)
        );

        let pictured = by_hand(|txn, sequence, _| {
            line(txn, sequence, "paragraph", &[]);
            let at = sequence.len(txn);
            let image = sequence.insert_embed(txn, at, XmlElementPrelim::empty("image"));
            image.insert_attribute(txn, "src", Any::from("b.png"));
            image.insert_attribute(txn, "alt", Any::from("a"));
        });
        let image = |key: &'static str| {
            move |txn: &mut TransactionMut, sequence: &TextRef, _: &MapRef| {
                let mut found = None;
                let _ = sequence.try_visit_items(&*txn, |item| {
                    if let yrs::types::text::TextItem::Embed(Out::YXmlElement(element)) = item {
                        if element.tag().as_ref() == "image" {
                            found = Some(element);
                        }
                    }
                    Ok::<_, ()>(())
                });
                found
                    .expect("the image")
                    .insert_attribute(txn, key, Any::from("c"));
            }
        };
        assert_eq!(edited(&pictured, image("src")), Hold(LiveDeletion));
        assert_eq!(edited(&pictured, image("title")), Hold(ExistingParentKey));
    });
}

#[test]
fn a_note_that_does_not_read_as_format_two_keeps_todays_rule() {
    let record = |txn: &mut TransactionMut, _: &TextRef, containers: &MapRef| {
        containers.insert(txn, "c", Any::from("callout"));
    };
    reading_body_sequence_here(|| {
        let one = Ydoc::with_client_id(SEED);
        one.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, "ab\n")
            .expect("format 1");
        assert_eq!(one.note_schema_version(), 1);
        assert_eq!(edited(&one, record), Hold(ExistingParentKey));
        let peer = copy(&one, LATE);
        let body = peer.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let before = peer.doc.transact().state_vector();
        {
            let mut txn = peer.doc.transact_mut();
            let Some(XmlOut::Element(paragraph)) = body.get(&txn, 0) else {
                panic!("a paragraph");
            };
            let Some(XmlOut::Text(text)) = paragraph.get(&txn, 0) else {
                panic!("its text");
            };
            text.format(&mut txn, 0, 2, bold());
        }
        let bolded = peer.doc.transact().encode_state_as_update_v1(&before);
        assert_eq!(
            inspect_update(&head(&[&one]), &bolded),
            Hold(ExistingTextFormat)
        );

        let meta = one.doc.get_or_insert_map(ROOT_META);
        meta.insert(
            &mut one.doc.transact_mut(),
            "schemaVersion",
            Any::Number(2.0),
        );
        assert_eq!(one.note_schema_version(), 2);
        assert_eq!(edited(&one, record), Hold(ExistingParentKey));
    });
    let two = reading_body_sequence_here(|| note("ab\n"));
    let peer = copy(&two, LATE);
    let update = edit(&peer, |txn, sequence, _| sequence.format(txn, 1, 2, bold()));
    assert_eq!(
        inspect_update(&head(&[&two]), &update),
        Hold(ExistingTextFormat)
    );
}
