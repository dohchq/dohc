use std::sync::Arc;

use yrs::block::{BLOCK_ITEM_STRING_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB, HAS_RIGHT_ORIGIN};
use yrs::types::{Attrs, TYPE_REFS_XML_ELEMENT, TYPE_REFS_XML_TEXT};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, TransactionMut,
    Update, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef, XmlTextPrelim,
    XmlTextRef,
};

use super::super::scan_v2;
use super::*;
use crate::{merge_updates, ContentKind, ROOT_BODY, ROOT_FRONTMATTER, ROOT_PLAINTEXT};

use StructuralHold::*;
use UpdateInspection::{Admissible, Hold};

/// A peer with the durable document's options.
fn peer(client: u64) -> Doc {
    Doc::with_options(Options {
        client_id: ClientID::new(client),
        offset_kind: OffsetKind::Utf16,
        skip_gc: true,
        ..Options::default()
    })
}

/// Edit `doc` in one transaction and return the update `Ydoc::with_delta`
/// journals for it: everything after the prior state vector, with the whole
/// store's delete set.
fn delta(doc: &Doc, edit: impl FnOnce(&mut TransactionMut)) -> Vec<u8> {
    let before = doc.transact().state_vector();
    edit(&mut doc.transact_mut());
    doc.transact().encode_state_as_update_v1(&before)
}

/// A head holding `doc`'s current state.
fn head(doc: &Doc) -> Ydoc {
    let head = Ydoc::wire();
    head.apply(&full_state(doc)).unwrap();
    head
}

fn full_state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

/// Append a paragraph holding `text` to the body.
fn append(
    body: &XmlFragmentRef,
    txn: &mut TransactionMut,
    text: &str,
) -> (XmlElementRef, XmlTextRef) {
    let index = body.len(txn);
    let element = body.insert(txn, index, XmlElementPrelim::empty("paragraph"));
    let text = element.insert(txn, 0, XmlTextPrelim::new(text));
    (element, text)
}

/// A peer whose body holds one paragraph of `text`.
fn with_paragraph(client: u64, text: &str) -> (Doc, XmlElementRef, XmlTextRef) {
    let doc = peer(client);
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let (element, text) = append(&body, &mut doc.transact_mut(), text);
    (doc, element, text)
}

fn append_update(doc: &Doc, text: &str) -> Vec<u8> {
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    delta(doc, |txn| {
        append(&body, txn, text);
    })
}

fn has_deletions(update: &[u8]) -> bool {
    !scan_v2(update).unwrap().deleted_ranges.is_empty()
}

fn has_skip(update: &[u8]) -> bool {
    scan_v2(update)
        .unwrap()
        .blocks
        .values()
        .flatten()
        .any(|block| block.kind == BlockKind::Skip)
}

/// The text of the body's first paragraph.
fn first_text(doc: &Doc) -> XmlTextRef {
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let txn = doc.transact();
    let element = body.get(&txn, 0).unwrap().into_xml_element().unwrap();
    element.get(&txn, 0).unwrap().into_xml_text().unwrap()
}

/// A hand-encoded v1 update of client `sections`, with no deletions.
fn wire(sections: &[Vec<u8>]) -> Vec<u8> {
    let mut update = vec![sections.len() as u8];
    update.extend(sections.concat());
    update.push(0);
    update
}

/// A client section of `blocks`, the first at `clock`.
fn section(client: u8, clock: u8, blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut section = vec![blocks.len() as u8, client, clock];
    section.extend(blocks.concat());
    section
}

/// A short v1 string: its length, then its bytes.
fn wire_string(text: &str) -> Vec<u8> {
    let mut bytes = vec![text.len() as u8];
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// A string block after `left`, and before `right` if given.
fn string_between(left: (u8, u8), right: Option<(u8, u8)>, text: &str) -> Vec<u8> {
    let mut block = vec![HAS_ORIGIN | BLOCK_ITEM_STRING_REF_NUMBER, left.0, left.1];
    if let Some((client, clock)) = right {
        block[0] |= HAS_RIGHT_ORIGIN;
        block.extend([client, clock]);
    }
    block.extend(wire_string(text));
    block
}

/// A type block at the start of the body.
fn body_type(type_ref: &[u8]) -> Vec<u8> {
    [
        vec![BLOCK_ITEM_TYPE_REF_NUMBER, 1],
        wire_string(ROOT_BODY),
        type_ref.to_vec(),
    ]
    .concat()
}

/// A head holding client 1's note "a" at 1:0 and client 2's frontmatter
/// title at 2:0.
fn note_and_title() -> Ydoc {
    let (note, title) = (peer(1), peer(2));
    let text = note.get_or_insert_text(ROOT_PLAINTEXT);
    text.insert(&mut note.transact_mut(), 0, "a");
    let frontmatter = title.get_or_insert_map(ROOT_FRONTMATTER);
    frontmatter.insert(&mut title.transact_mut(), "title", "Draft");
    let head = head(&note);
    head.apply(&full_state(&title)).unwrap();
    head
}

/// The production desktop fold over canonical Markdown with no metadata writes
/// removes every body block the head holds; the delete set alone holds it.
#[test]
fn a_desktop_fold_holds_on_its_deletions_alone() {
    let markdown = "First paragraph.\n\nSecond paragraph.";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
        .unwrap();
    assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, markdown);
    let head = Ydoc::wire();
    head.apply(&doc.encode_full_state()).unwrap();
    let fold = doc
        .rewrite_content_to_markdown_for_fold(
            ContentKind::Richdoc,
            "First paragraph.\n\nSecond paragraph, edited.",
        )
        .unwrap();
    assert_eq!(inspect_update(&head, &fold), Hold(LiveDeletion));
}

/// Every journaled update carries the store's delete set, so an append to a
/// document that already deleted content repeats that deletion.
#[test]
fn a_safe_append_after_historical_deletions_is_admissible() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    append(&body, &mut doc.transact_mut(), "Gone");
    body.remove_range(&mut doc.transact_mut(), 1, 1);
    let head = head(&doc);
    let update = append_update(&doc, "Typed after");
    assert!(has_deletions(&update));
    assert_eq!(inspect_update(&head, &update), Admissible);
    head.apply(&update).unwrap();
    assert_eq!(inspect_update(&head, &update), Admissible, "redelivery");
}

/// One delete range, partly deleted already and partly live, holds on its
/// live remainder.
#[test]
fn a_partly_historical_range_holds_on_its_live_remainder() {
    let (doc, _, text) = with_paragraph(1, "abcdef");
    text.remove_range(&mut doc.transact_mut(), 1, 2);
    let head = head(&doc);
    let historical = scan_v2(&head.encode_full_state()).unwrap().deleted_ranges;
    let update = delta(&doc, |txn| text.remove_range(txn, 0, 2));
    let incoming = scan_v2(&update).unwrap().deleted_ranges;
    let (client, ranges) = historical.iter().next().unwrap();
    let (start, end) = ranges[0];
    assert!(
        incoming[client]
            .iter()
            .any(|&(from, to)| from < start && end < to),
        "one range spans the historical deletion and live clocks on both sides"
    );
    assert_eq!(inspect_update(&head, &update), Hold(LiveDeletion));
}

/// A candidate may delete items it inserts itself.
#[test]
fn a_candidate_deleting_its_own_fresh_items_is_admissible() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let head = head(&doc);
    let update = delta(&doc, |txn| {
        let (_, text) = append(&body, txn, "Fresh text");
        text.remove_range(txn, 0, 6);
    });
    assert!(has_deletions(&update));
    assert_eq!(inspect_update(&head, &update), Admissible);
}

/// A skipped range is absent from both sides, so deleting it is unproven
/// even though the same peer created it.
#[test]
fn a_skip_cannot_prove_its_deletion_fresh() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let head = head(&doc);
    let first = append_update(&doc, "A");
    append_update(&doc, "B");
    let removal = delta(&doc, |txn| {
        body.remove_range(txn, 2, 1);
        let element = body.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
        element.insert(txn, 0, XmlTextPrelim::new("C"));
    });
    let update = merge_updates(&[first, removal]).unwrap();
    assert!(has_skip(&update));
    assert_eq!(inspect_update(&head, &update), Hold(UnprovenDeletion));
}

/// A fresh paragraph placed after one the head lacks cannot prove the
/// deletion of its own text: the text integrates only with its paragraph.
#[test]
fn an_unresolved_dependency_cannot_prove_its_deletion_fresh() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let head = head(&doc);
    let other = peer(2);
    let body = other.get_or_insert_xml_fragment(ROOT_BODY);
    apply(&other, &full_state(&doc));
    let missing = append_update(&doc, "Missing");
    apply(&other, &missing);
    let typed = append_update(&other, "Typed after it");
    assert_eq!(inspect_update(&head, &typed), Hold(UnresolvedReference));
    let trimmed = delta(&other, |txn| {
        let (_, text) = append(&body, txn, "Typed and trimmed");
        text.remove_range(txn, 0, 6);
    });
    let update = merge_updates(&[typed, trimmed]).unwrap();
    assert_eq!(inspect_update(&head, &update), Hold(UnprovenDeletion));
    head.apply(&missing).unwrap();
    assert_eq!(inspect_update(&head, &update), Admissible);
}

#[test]
fn a_map_keyed_overwrite_of_an_existing_value_holds() {
    let doc = peer(1);
    let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
    frontmatter.insert(&mut doc.transact_mut(), "title", "Draft");
    let head = head(&doc);
    let update = delta(&doc, |txn| {
        frontmatter.insert(txn, "title", "Final");
    });
    assert_eq!(inspect_update(&head, &update), Hold(LiveDeletion));
}

/// The frontmatter root exists before any key does.
#[test]
fn a_brand_new_frontmatter_key_holds() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
    let head = head(&doc);
    let update = delta(&doc, |txn| {
        frontmatter.insert(txn, "tags", "new");
    });
    assert!(!has_deletions(&update));
    assert_eq!(inspect_update(&head, &update), Hold(ExistingParentKey));
}

#[test]
fn an_attribute_update_on_an_existing_paragraph_holds() {
    let (doc, element, _) = with_paragraph(1, "Kept");
    let head = head(&doc);
    let update = delta(&doc, |txn| {
        element.insert_attribute(txn, "align", "center");
    });
    assert!(!has_deletions(&update));
    assert_eq!(inspect_update(&head, &update), Hold(ExistingParentKey));
}

/// A value set again after its key was removed names neither its parent nor
/// its key on the wire: both come from its origin, the removed value.
#[test]
fn an_overwrite_inheriting_its_parent_and_key_holds() {
    let doc = peer(1);
    let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
    frontmatter.insert(&mut doc.transact_mut(), "title", "Draft");
    frontmatter.remove(&mut doc.transact_mut(), "title");
    let head = head(&doc);
    let update = delta(&doc, |txn| {
        frontmatter.insert(txn, "title", "Final");
    });
    let blocks = scan_v2(&update).unwrap().blocks;
    let block = &blocks.values().next().unwrap()[0];
    assert!(block.left_origin.is_some() && block.parent.is_none() && block.parent_sub.is_none());
    assert_eq!(inspect_update(&head, &update), Hold(ExistingParentKey));
}

#[test]
fn a_formatting_change_over_existing_text_holds() {
    let (doc, _, text) = with_paragraph(1, "hello");
    let head = head(&doc);
    let bold = Attrs::from([(Arc::from("bold"), Any::Bool(true))]);
    let update = delta(&doc, |txn| text.format(txn, 0, 5, bold));
    assert!(!has_deletions(&update));
    assert_eq!(inspect_update(&head, &update), Hold(ExistingTextFormat));
}

/// A new paragraph may set its own attributes and format its own text.
#[test]
fn a_new_paragraph_with_its_own_attributes_is_admissible() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let head = head(&doc);
    let bold = Attrs::from([(Arc::from("bold"), Any::Bool(true))]);
    let update = delta(&doc, |txn| {
        let heading = body.insert(txn, 1, XmlElementPrelim::empty("heading"));
        heading.insert_attribute(txn, "level", 2_i64);
        let text = heading.insert(txn, 0, XmlTextPrelim::new(""));
        text.insert_with_attributes(txn, 0, "Bold title", bold);
    });
    assert_eq!(inspect_update(&head, &update), Admissible);
}

/// Hand-encoded: client 9 holds a collected block and client 11 a root
/// text "ab". yrs would fall back to the right origin; inspection fails closed.
#[test]
fn an_origin_in_a_collected_block_holds() {
    let head = Ydoc::wire();
    let mut state = vec![2, 1, 9, 0, 0, 3, 1, 11, 0, 4, 1, ROOT_PLAINTEXT.len() as u8];
    state.extend_from_slice(ROOT_PLAINTEXT.as_bytes());
    state.extend_from_slice(&[2, b'a', b'b', 0]);
    head.apply(&state).unwrap();
    let insert_after = |client, clock| {
        vec![
            1,
            1,
            10,
            0,
            0x80 | 0x40 | 4,
            client,
            clock,
            11,
            0,
            1,
            b'x',
            0,
        ]
    };
    assert_eq!(inspect_update(&head, &insert_after(11, 1)), Admissible);
    assert_eq!(
        inspect_update(&head, &insert_after(9, 1)),
        Hold(CollectedReference)
    );
}

/// An otherwise admissible update into a fresh root text.
fn unrelated_note() -> Vec<u8> {
    let doc = peer(3);
    let note = doc.get_or_insert_text(ROOT_PLAINTEXT);
    delta(&doc, |txn| note.insert(txn, 0, "note"))
}

#[test]
fn a_head_with_pending_updates_holds() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let head = head(&doc);
    assert_eq!(inspect_update(&head, &unrelated_note()), Admissible);
    append_update(&doc, "Missing");
    head.apply(&append_update(&doc, "Parked")).unwrap();
    assert!(head.pending_update_v1().is_some());
    assert_eq!(inspect_update(&head, &unrelated_note()), Hold(PendingState));
}

#[test]
fn a_head_with_pending_deletions_holds() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let body = doc.get_or_insert_xml_fragment(ROOT_BODY);
    let head = head(&doc);
    append_update(&doc, "Missing");
    head.apply(&delta(&doc, |txn| body.remove_range(txn, 1, 1)))
        .unwrap();
    assert!(head.pending_update_v1().is_none());
    assert!(head.pending_delete_set().is_some());
    assert_eq!(inspect_update(&head, &unrelated_note()), Hold(PendingState));
}

/// Client 9 sets the title at 9:0, then types into the note at 9:1. The head
/// receives only the note, behind a Skip, with nothing pending. yrs fills the
/// Skip with the late title, which replaces the head's.
#[test]
fn a_late_block_filling_a_head_skip_holds() {
    let doc = peer(1);
    let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
    frontmatter.insert(&mut doc.transact_mut(), "title", "Draft");
    let head = head(&doc);
    let other = peer(9);
    let frontmatter = other.get_or_insert_map(ROOT_FRONTMATTER);
    let note = other.get_or_insert_text(ROOT_PLAINTEXT);
    let title = delta(&other, |txn| {
        frontmatter.insert(txn, "title", "Final");
    });
    head.apply(&delta(&other, |txn| note.insert(txn, 0, "x")))
        .unwrap();
    assert!(!head.has_pending_dependencies());
    assert!(has_skip(&head.encode_full_state()));
    assert!(!has_deletions(&title));
    assert_eq!(inspect_update(&head, &title), Hold(PendingState));
}

/// Client 7 holds the title at 7:0, a Skip over [1,3) and a paragraph from
/// 7:3. A hand-encoded string at 7:1 after the title would replace it.
#[test]
fn a_block_between_known_blocks_of_a_head_skip_holds() {
    let doc = peer(7);
    let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
    let note = doc.get_or_insert_text(ROOT_PLAINTEXT);
    let head = Ydoc::wire();
    head.apply(&delta(&doc, |txn| {
        frontmatter.insert(txn, "title", "Draft");
    }))
    .unwrap();
    delta(&doc, |txn| note.insert(txn, 0, "ab"));
    head.apply(&append_update(&doc, "Body")).unwrap();
    assert!(!head.has_pending_dependencies());
    assert!(has_skip(&head.encode_full_state()));
    let update = wire(&[section(7, 1, &[string_between((7, 0), None, "x")])]);
    assert_eq!(inspect_update(&head, &update), Hold(PendingState));
}

/// Hand-encoded: client 5's section appears twice. The first appends to the
/// note. yrs integrates the second whole after the title, replacing it, so
/// the scan rejects the repeat.
#[test]
fn a_repeated_block_section_holds() {
    let head = note_and_title();
    let append = section(5, 0, &[string_between((1, 0), None, "y")]);
    let overwrite = section(5, 0, &[string_between((2, 0), None, "z")]);
    assert_eq!(
        inspect_update(&head, &wire(std::slice::from_ref(&append))),
        Admissible
    );
    assert_eq!(
        inspect_update(&head, &wire(&[append, overwrite])),
        Hold(Unclassifiable)
    );
}

/// Sol's bytes: client 3 types "x" after the note's "a" and before the title.
/// yrs takes the parent from the left and the key from the right, so the
/// string would replace the "a".
#[test]
fn a_right_origin_in_another_parent_holds() {
    let head = note_and_title();
    let update = [1, 1, 3, 0, 196, 1, 0, 2, 0, 1, 120, 0];
    assert_eq!(
        update.to_vec(),
        wire(&[section(3, 0, &[string_between((1, 0), Some((2, 0)), "x")])])
    );
    assert_eq!(inspect_update(&head, &update), Hold(Unclassifiable));
    let typed = wire(&[section(3, 0, &[string_between((1, 0), None, "x")])]);
    assert_eq!(inspect_update(&head, &typed), Admissible);
}

/// Hand-encoded: a string whose only origin is the title's value on its right
/// takes the title key from it, like yrs.
#[test]
fn a_right_origin_alone_gives_its_key() {
    let head = note_and_title();
    let block = [
        vec![HAS_RIGHT_ORIGIN | BLOCK_ITEM_STRING_REF_NUMBER, 2, 0],
        wire_string("x"),
    ]
    .concat();
    let update = wire(&[section(3, 0, &[block])]);
    assert_eq!(inspect_update(&head, &update), Hold(ExistingParentKey));
}

/// Hand-encoded: a string after a paragraph's last character and before an
/// attribute of the same text. yrs keys the string by the attribute and
/// deletes the "ab" before it.
#[test]
fn a_right_origin_with_another_key_holds() {
    let (doc, _, text) = with_paragraph(1, "ab");
    assert_eq!(
        doc.transact().state_vector().get(&ClientID::new(1)),
        4,
        "the paragraph, its text and \"ab\" span 1:0 to 1:3"
    );
    text.insert_attribute(&mut doc.transact_mut(), "k", "v");
    let head = head(&doc);
    let typed = wire(&[section(3, 0, &[string_between((1, 3), None, "x")])]);
    assert_eq!(inspect_update(&head, &typed), Admissible);
    let keyed = wire(&[section(3, 0, &[string_between((1, 3), Some((1, 4)), "x")])]);
    assert_eq!(inspect_update(&head, &keyed), Hold(Unclassifiable));
}

/// Hand-encoded: client 1 re-sends its last character "b" at 1:3 with a new
/// one, as a block keyed "k" in a fresh paragraph. yrs links the new part
/// after the head's "b", keys it and deletes the head's "ab".
#[test]
fn a_partly_known_block_with_its_own_parent_and_key_holds() {
    let (doc, _, _) = with_paragraph(1, "ab");
    let head = head(&doc);
    let paragraph = body_type(&[vec![TYPE_REFS_XML_ELEMENT], wire_string("paragraph")].concat());
    let resent = [
        vec![HAS_PARENT_SUB | BLOCK_ITEM_STRING_REF_NUMBER, 0, 5, 0],
        wire_string("k"),
        wire_string("bz"),
    ]
    .concat();
    let fresh = section(5, 0, &[paragraph]);
    assert_eq!(
        inspect_update(&head, &wire(std::slice::from_ref(&fresh))),
        Admissible
    );
    let update = wire(&[fresh, section(1, 3, &[resent])]);
    assert_eq!(inspect_update(&head, &update), Hold(Unclassifiable));
}

/// Hand-encoded: client 1 re-sends "c" at 1:4, inside the existing "acb",
/// with a new character, as a block of a fresh text; then bolds after it.
/// yrs links both after the head's "c", splicing the mark into existing text.
#[test]
fn a_format_after_a_partly_known_block_in_another_parent_holds() {
    let (doc, _, text) = with_paragraph(1, "ab");
    text.insert(&mut doc.transact_mut(), 1, "c");
    assert_eq!(doc.transact().state_vector().get(&ClientID::new(1)), 5);
    let head = head(&doc);
    let resent = [
        vec![BLOCK_ITEM_STRING_REF_NUMBER, 0, 5, 0],
        wire_string("cz"),
    ]
    .concat();
    let bold = [
        vec![HAS_ORIGIN | BLOCK_ITEM_FORMAT_REF_NUMBER, 1, 5],
        wire_string("bold"),
        wire_string("true"),
    ]
    .concat();
    let update = wire(&[
        section(5, 0, &[body_type(&[TYPE_REFS_XML_TEXT])]),
        section(1, 4, &[resent, bold]),
    ]);
    assert_eq!(inspect_update(&head, &update), Hold(Unclassifiable));
}

/// Two peers type into the same paragraph at the same place and each append
/// a paragraph. Their merged update only adds.
#[test]
fn an_honest_concurrent_update_from_two_peers_is_admissible() {
    let (doc, _, _) = with_paragraph(1, "Kept");
    let head = head(&doc);
    let updates: Vec<Vec<u8>> = [(2, "X", "Two"), (3, "Y", "Three")]
        .into_iter()
        .map(|(client, typed, appended)| {
            let other = peer(client);
            apply(&other, &full_state(&doc));
            let text = first_text(&other);
            let body = other.get_or_insert_xml_fragment(ROOT_BODY);
            delta(&other, |txn| {
                text.insert(txn, 2, typed);
                append(&body, txn, appended);
            })
        })
        .collect();
    let update = merge_updates(&updates).unwrap();
    assert_eq!(scan_v2(&update).unwrap().blocks.len(), 2);
    assert_eq!(inspect_update(&head, &update), Admissible);
    head.apply(&update).unwrap();
    assert_eq!(inspect_update(&head, &update), Admissible, "redelivery");
}

/// A peer's store squashes its typing into one block, which the head knows in
/// part. The new part's synthetic origin is the head's copy, in the same
/// parent.
#[test]
fn an_honest_partly_known_block_is_admissible() {
    let doc = peer(1);
    let note = doc.get_or_insert_text(ROOT_PLAINTEXT);
    let head = Ydoc::wire();
    head.apply(&delta(&doc, |txn| note.insert(txn, 0, "ab")))
        .unwrap();
    note.insert(&mut doc.transact_mut(), 2, "cd");
    let update = full_state(&doc);
    let blocks = scan_v2(&update).unwrap().blocks;
    let squashed = &blocks[&ClientID::new(1)];
    assert!(squashed.len() == 1 && squashed[0].len == 4 && squashed[0].parent.is_some());
    assert_eq!(inspect_update(&head, &update), Admissible);
}
