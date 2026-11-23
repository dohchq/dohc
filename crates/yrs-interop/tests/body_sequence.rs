use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use yrs::branch::{Branch, BranchID};
use yrs::types::text::{Diff, TextDiffChunk, YChange};
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, ClientID, Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update, Xml, XmlElementPrelim, XmlElementRef, ID,
};

const ROOT: &str = "sequence";
const SEED: &[u8] = include_bytes!("../fixtures/body_sequence/seed.bin");
const JOIN: &[u8] = include_bytes!("../fixtures/body_sequence/join.bin");
const UNDO_JOIN: &[u8] = include_bytes!("../fixtures/body_sequence/undo_join.bin");
const CHANGE_TYPE: &[u8] = include_bytes!("../fixtures/body_sequence/change_type.bin");
const DELETE_BOUNDARY: &[u8] = include_bytes!("../fixtures/body_sequence/delete_boundary.bin");
const WITH_MAP: &[u8] = include_bytes!("../fixtures/body_sequence/with_map.bin");

#[derive(Debug, PartialEq)]
enum Content {
    Text(String),
    Element(String, BTreeMap<String, Out>),
    Map(BTreeMap<String, Out>),
}

type Chunk = (Content, Attrs);

fn engine_doc() -> Doc {
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        skip_gc: true,
        ..Options::default()
    });
    doc.get_or_insert_text(ROOT);
    doc
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn assert_body(doc: &Doc, len: u32, expected: Vec<Chunk>) {
    let text = doc.get_or_insert_text(ROOT);
    let txn = doc.transact();
    assert_eq!(text.len(&txn), len);
    let diff = text.diff(&txn, YChange::identity);
    let mut visited: Vec<Diff<YChange>> = Vec::new();
    text.try_visit_diff(&txn, |chunk| -> Result<(), Infallible> {
        let (insert, attributes) = match chunk {
            TextDiffChunk::Text {
                text,
                attributes,
                continues_previous: true,
            } => {
                let previous = visited.last_mut().expect("continuation follows text");
                assert_eq!(previous.attributes.as_deref(), attr_ref(attributes));
                let Out::Any(Any::String(value)) = &previous.insert else {
                    panic!("continuation follows a text insert");
                };
                let mut value = value.to_string();
                value.push_str(text);
                previous.insert = value.into();
                return Ok(());
            }
            TextDiffChunk::Text {
                text, attributes, ..
            } => (text.into(), attributes),
            TextDiffChunk::Embed { insert, attributes } => (insert, attributes),
        };
        visited.push(Diff::new(
            insert,
            attr_ref(attributes).cloned().map(Box::new),
        ));
        Ok(())
    })
    .unwrap();
    assert_eq!(visited, diff);

    let actual: Vec<_> = diff
        .into_iter()
        .map(|chunk| {
            let content = match chunk.insert {
                Out::Any(Any::String(value)) => Content::Text(value.to_string()),
                Out::YXmlElement(node) => Content::Element(
                    node.tag().to_string(),
                    node.attributes(&txn)
                        .map(|(key, value)| (key.to_owned(), value))
                        .collect(),
                ),
                Out::YMap(map) => Content::Map(
                    map.iter(&txn)
                        .map(|(key, value)| (key.to_owned(), value))
                        .collect(),
                ),
                other => panic!("unexpected body item: {other:?}"),
            };
            (content, *chunk.attributes.unwrap_or_default())
        })
        .collect();
    assert_eq!(actual, expected);
}

fn attr_ref(attrs: &Attrs) -> Option<&Attrs> {
    (!attrs.is_empty()).then_some(attrs)
}

fn bold() -> Attrs {
    Attrs::from([("bold".into(), true.into())])
}

fn link() -> Attrs {
    Attrs::from([(
        "link".into(),
        Any::from(HashMap::from([
            ("href".to_owned(), "https://example.com"),
            ("title".to_owned(), "Example"),
        ])),
    )])
}

fn letters(value: &str, attrs: Attrs) -> Chunk {
    (Content::Text(value.to_owned()), attrs)
}

fn element<const N: usize>(name: &str, fields: [(&str, Out); N], attrs: Attrs) -> Chunk {
    (
        Content::Element(
            name.to_owned(),
            BTreeMap::from(fields.map(|(key, value)| (key.to_owned(), value))),
        ),
        attrs,
    )
}

fn seed_chunks(heading_type: &str) -> Vec<Chunk> {
    vec![
        element("block", [("type", "paragraph".into())], Attrs::new()),
        letters("O", Attrs::new()),
        letters("ne", bold()),
        element(
            "block",
            [("type", heading_type.into()), ("level", 2.into())],
            bold(),
        ),
        letters("Tw", bold()),
        letters("o", Attrs::new()),
        element("image", [("src", "a.png".into())], Attrs::new()),
        letters("x", link()),
    ]
}

fn joined_chunks() -> Vec<Chunk> {
    let mut chunks = seed_chunks("heading");
    drop(chunks.splice(2..5, [letters("neTw", bold())]));
    chunks
}

fn element_at(doc: &Doc, chunk: usize) -> XmlElementRef {
    let body = doc.get_or_insert_text(ROOT);
    let diff = body.diff(&doc.transact(), YChange::identity);
    let Out::YXmlElement(node) = &diff[chunk].insert else {
        panic!("expected an element in chunk {chunk}");
    };
    node.clone()
}

#[test]
fn reads_yjs_seed_and_map() {
    let doc = engine_doc();
    apply(&doc, SEED);
    assert_body(&doc, 10, seed_chunks("heading"));

    let doc = engine_doc();
    apply(&doc, WITH_MAP);
    let mut expected = seed_chunks("heading");
    expected.push((
        Content::Map(BTreeMap::from([("label".to_owned(), "metadata".into())])),
        Attrs::new(),
    ));
    assert_body(&doc, 11, expected);
}

#[test]
fn reads_yjs_join_and_undo() {
    let doc = engine_doc();
    apply(&doc, SEED);
    let old = element_at(&doc, 3);
    let old_id = ID::new(ClientID::new(1), 5);
    assert_eq!(AsRef::<Branch>::as_ref(&old).id(), BranchID::Nested(old_id));

    apply(&doc, JOIN);
    assert_body(&doc, 9, joined_chunks());
    assert!(doc.transact().snapshot().delete_set.contains(&old_id));

    apply(&doc, UNDO_JOIN);
    assert_body(&doc, 10, seed_chunks("heading"));
    let restored = element_at(&doc, 3);
    assert_eq!(
        AsRef::<Branch>::as_ref(&restored).id(),
        BranchID::Nested(ID::new(ClientID::new(2), 0))
    );
    assert!(doc.transact().snapshot().delete_set.contains(&old_id));
}

#[test]
fn reads_concurrent_yjs_boundary_change_and_delete_in_both_orders() {
    let doc = engine_doc();
    apply(&doc, SEED);
    apply(&doc, CHANGE_TYPE);
    assert_body(&doc, 10, seed_chunks("codeBlock"));
    apply(&doc, DELETE_BOUNDARY);
    assert_body(&doc, 9, joined_chunks());

    let doc = engine_doc();
    apply(&doc, SEED);
    apply(&doc, DELETE_BOUNDARY);
    assert_body(&doc, 9, joined_chunks());
    apply(&doc, CHANGE_TYPE);
    assert_body(&doc, 9, joined_chunks());
}

#[test]
fn writes_round_trips_and_edits_the_body_in_rust() {
    let doc = engine_doc();
    let body = doc.get_or_insert_text(ROOT);
    {
        let mut txn = doc.transact_mut();
        let paragraph = body.insert_embed(&mut txn, 0, XmlElementPrelim::empty("block"));
        paragraph.insert_attribute(&mut txn, "type", "paragraph");
        body.insert(&mut txn, 1, "O");
        body.insert_with_attributes(&mut txn, 2, "neTw", bold());
        let heading = body.insert_embed(&mut txn, 4, XmlElementPrelim::empty("block"));
        heading.insert_attribute(&mut txn, "type", "heading");
        heading.insert_attribute(&mut txn, "level", 2);
        body.insert_with_attributes(&mut txn, 7, "o", Attrs::new());
        let image = body.insert_embed(&mut txn, 8, XmlElementPrelim::empty("image"));
        image.insert_attribute(&mut txn, "src", "a.png");
        body.insert_with_attributes(&mut txn, 9, "x", link());
    }
    assert_body(&doc, 10, seed_chunks("heading"));

    let peer = engine_doc();
    apply(&peer, &encode(&doc));
    assert_body(&peer, 10, seed_chunks("heading"));

    let body = peer.get_or_insert_text(ROOT);
    body.remove_range(&mut peer.transact_mut(), 4, 1);
    assert_body(&peer, 9, joined_chunks());

    let paragraph = element_at(&peer, 0);
    let id = AsRef::<Branch>::as_ref(&paragraph).id();
    paragraph.insert_attribute(&mut peer.transact_mut(), "type", "codeBlock");
    assert_eq!(AsRef::<Branch>::as_ref(&element_at(&peer, 0)).id(), id);
    let mut expected = joined_chunks();
    expected[0] = element("block", [("type", "codeBlock".into())], Attrs::new());
    assert_body(&peer, 9, expected);
}

#[test]
fn removing_the_letter_before_an_unmarked_element_makes_the_element_bold() {
    let doc = engine_doc();
    let body = doc.get_or_insert_text(ROOT);
    {
        let mut txn = doc.transact_mut();
        body.insert_with_attributes(&mut txn, 0, "ab", bold());
        body.insert_embed_with_attributes(
            &mut txn,
            2,
            XmlElementPrelim::empty("block"),
            Attrs::new(),
        );
        body.insert_with_attributes(&mut txn, 3, "cd", bold());
    }
    assert_body(
        &doc,
        5,
        vec![
            letters("ab", bold()),
            element("block", [], Attrs::new()),
            letters("cd", bold()),
        ],
    );

    body.remove_range(&mut doc.transact_mut(), 1, 1);
    assert_body(
        &doc,
        4,
        vec![
            letters("a", bold()),
            element("block", [], bold()),
            letters("cd", bold()),
        ],
    );
}

#[test]
fn reencodes_yjs_body() {
    let doc = engine_doc();
    apply(&doc, SEED);
    let peer = engine_doc();
    apply(&peer, &encode(&doc));
    assert_body(&peer, 10, seed_chunks("heading"));
}
