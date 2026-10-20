use std::sync::Arc;

use yrs::types::Attrs;
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
    let blocks = scan_v2(&update).unwrap().blocks;
    assert!(blocks
        .values()
        .flatten()
        .any(|block| block.kind == BlockKind::Skip));
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
