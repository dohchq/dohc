use yrs::deleted_content::{deleted_runs, Places};
use yrs::types::xml::{XmlElementPrelim, XmlFragment, XmlTextPrelim};
use yrs::updates::decoder::Decode;
use yrs::{Any, BranchID, Doc, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update, Xml};

fn keeping() -> Doc {
    Doc::with_options(Options {
        skip_gc: true,
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

fn changes(doc: &Doc, before: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(before)
}

/// One paragraph holding `text`, shared by two documents.
fn paragraph(text: &str) -> (Doc, Doc) {
    let a = keeping();
    let body = a.get_or_insert_xml_fragment("body");
    {
        let mut txn = a.transact_mut();
        let line = body.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        line.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    let b = keeping();
    let update = a.transact().encode_state_as_update_v1(&StateVector::default());
    b.transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    (a, b)
}

fn first_text(doc: &Doc) -> yrs::XmlTextRef {
    let body = doc.get_or_insert_xml_fragment("body");
    let txn = doc.transact();
    let line = body.get(&txn, 0).unwrap().into_xml_element().unwrap();
    line.get(&txn, 0).unwrap().into_xml_text().unwrap()
}

#[test]
fn reads_text_typed_into_a_line_someone_else_deleted() {
    let (a, b) = paragraph("Hello");
    let before = a.transact().state_vector();
    {
        let text = first_text(&a);
        let mut txn = a.transact_mut();
        let end = text.len(&txn);
        text.insert(&mut txn, end, " world");
    }
    let typed = changes(&a, &before);
    let before = b.transact().state_vector();
    {
        let body = b.get_or_insert_xml_fragment("body");
        body.remove_range(&mut b.transact_mut(), 0, 1);
    }
    let removed = changes(&b, &before);

    let line_id = {
        let body = a.get_or_insert_xml_fragment("body");
        let txn = a.transact();
        let line = body.get(&txn, 0).unwrap().into_xml_element().unwrap();
        match line.as_ref().id() {
            BranchID::Nested(id) => id,
            BranchID::Root(_) => panic!("a paragraph is nested"),
        }
    };
    // The deleter's page receives the typing after its delete.
    let mut txn = b.transact_mut();
    txn.apply_update(Update::decode_v1(&typed).unwrap()).unwrap();
    txn.commit();
    let set = txn.delete_set().clone();
    let mut places = Places::default();
    let mut runs: Vec<_> = deleted_runs(&txn, &set)
        .into_iter()
        .filter(|run| run.in_xml_text() && !run.keyed())
        .map(|run| (run.place(&mut places), run.text().unwrap().to_owned(), run.line()))
        .collect();
    runs.sort();
    assert_eq!(
        runs.iter().map(|(_, text, line)| (text.as_str(), *line)).collect::<Vec<_>>(),
        vec![(" world", Some(line_id))]
    );
    drop(txn);

    // The typist's page receives the delete: all of the line's text goes, in order.
    let mut txn = a.transact_mut();
    txn.apply_update(Update::decode_v1(&removed).unwrap()).unwrap();
    txn.commit();
    let set = txn.delete_set().clone();
    let mut places = Places::default();
    let mut runs: Vec<_> = deleted_runs(&txn, &set)
        .into_iter()
        .filter(|run| run.in_xml_text())
        .map(|run| (run.place(&mut places), run.text().unwrap().to_owned()))
        .collect();
    runs.sort();
    assert_eq!(
        runs.into_iter().map(|(_, text)| text).collect::<String>(),
        "Hello world"
    );
}

#[test]
fn counts_clocks_in_utf16_units_when_it_cuts_text() {
    let (a, _) = paragraph("a😀bc");
    let text = first_text(&a);
    let mut txn = a.transact_mut();
    // "😀b": the emoji is two UTF-16 units.
    text.remove_range(&mut txn, 1, 3);
    txn.commit();
    let set = txn.delete_set().clone();
    let runs = deleted_runs(&txn, &set);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].len(), 3);
    assert_eq!(runs[0].text(), Some("😀b"));
    assert_eq!(runs[0].narrowed(2, 3).text(), Some("b"));
}

#[test]
fn reads_a_deleted_inline_element_and_its_attributes() {
    let (a, _) = paragraph("x");
    let body = a.get_or_insert_xml_fragment("body");
    {
        let mut txn = a.transact_mut();
        let line = body.get(&txn, 0).unwrap().into_xml_element().unwrap();
        let image = line.insert(&mut txn, 1, XmlElementPrelim::empty("image"));
        image.insert_attribute(&mut txn, "src", "a.png");
        image.insert_attribute(&mut txn, "alt", "A");
    }
    let mut txn = a.transact_mut();
    let line = body.get(&txn, 0).unwrap().into_xml_element().unwrap();
    line.remove_range(&mut txn, 1, 1);
    txn.commit();
    let set = txn.delete_set().clone();
    let runs = deleted_runs(&txn, &set);
    let element = runs
        .iter()
        .find_map(|run| run.element())
        .expect("the image is listed");
    assert_eq!(element.name(), "image");
    assert_eq!(element.attribute("src"), Some(Any::from("a.png")));
    assert_eq!(element.attribute("alt"), Some(Any::from("A")));
    assert_eq!(element.attribute("title"), None);
    assert!(runs.iter().all(|run| run.text().is_none() || run.keyed()));
}

