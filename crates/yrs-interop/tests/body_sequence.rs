use base64::Engine as _;
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use yrs::branch::{Branch, BranchID};
use yrs::types::text::{Diff, TextDiffChunk, TextItem, YChange};
use yrs::types::xml::{XmlFragment, XmlOut, XmlTextPrelim, XmlTextRef};
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, ClientID, Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update, Xml, XmlElementPrelim, XmlElementRef, ID,
};

const ROOT: &str = "sequence";
const UPDATES: &str =
    include_str!("../../../packages/ydoc-projection/src/fixtures/body-sequence-updates.json");

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

fn yjs_update(name: &str) -> Vec<u8> {
    let updates: HashMap<String, String> = serde_json::from_str(UPDATES).unwrap();
    base64::engine::general_purpose::STANDARD
        .decode(&updates[name])
        .unwrap()
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn apply_yjs(doc: &Doc, name: &str) {
    apply(doc, &yjs_update(name));
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
    apply_yjs(&doc, "seed");
    assert_body(&doc, 10, seed_chunks("heading"));

    let doc = engine_doc();
    apply_yjs(&doc, "with_map");
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
    apply_yjs(&doc, "seed");
    let old = element_at(&doc, 3);
    let old_id = ID::new(ClientID::new(1), 5);
    assert_eq!(AsRef::<Branch>::as_ref(&old).id(), BranchID::Nested(old_id));

    apply_yjs(&doc, "join");
    assert_body(&doc, 9, joined_chunks());
    assert!(doc.transact().snapshot().delete_set.contains(&old_id));

    apply_yjs(&doc, "undo_join");
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
    apply_yjs(&doc, "seed");
    apply_yjs(&doc, "change_type");
    assert_body(&doc, 10, seed_chunks("codeBlock"));
    apply_yjs(&doc, "delete_boundary");
    assert_body(&doc, 9, joined_chunks());

    let doc = engine_doc();
    apply_yjs(&doc, "seed");
    apply_yjs(&doc, "delete_boundary");
    assert_body(&doc, 9, joined_chunks());
    apply_yjs(&doc, "change_type");
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

fn bold_letters_around_an_unmarked_element() -> Doc {
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
    doc
}

#[test]
fn removing_the_letter_before_an_unmarked_element_leaves_the_element_unmarked() {
    let doc = bold_letters_around_an_unmarked_element();
    let body = doc.get_or_insert_text(ROOT);

    body.remove_range(&mut doc.transact_mut(), 1, 1);
    assert_body(
        &doc,
        4,
        vec![
            letters("a", bold()),
            element("block", [], Attrs::new()),
            letters("cd", bold()),
        ],
    );
}

#[test]
fn removing_the_letter_before_an_element_keeps_the_formatting_items_around_it() {
    let doc = bold_letters_around_an_unmarked_element();
    let body = doc.get_or_insert_text(ROOT);
    let (ends_bold, starts_bold) = (3, 5);
    let other = engine_doc();
    apply(&other, &encode(&doc));

    body.remove_range(&mut doc.transact_mut(), 1, 1);
    let deleted = doc.transact().snapshot().delete_set;
    assert!(deleted.contains(&ID::new(doc.client_id(), 2)));
    for formatting in [ends_bold, starts_bold] {
        assert!(!deleted.contains(&ID::new(doc.client_id(), formatting)));
    }

    let typed = other.get_or_insert_text(ROOT);
    typed.insert_with_attributes(&mut other.transact_mut(), 3, "x", Attrs::new());
    apply(&doc, &encode(&other));
    apply(&other, &encode(&doc));
    for merged in [&doc, &other] {
        assert_body(
            merged,
            5,
            vec![
                letters("a", bold()),
                element("block", [], Attrs::new()),
                letters("x", Attrs::new()),
                letters("cd", bold()),
            ],
        );
    }
}

fn paragraph_text(doc: &Doc) -> XmlTextRef {
    let body = doc.get_or_insert_xml_fragment("body");
    let txn = doc.transact();
    let Some(XmlOut::Element(paragraph)) = body.get(&txn, 0) else {
        panic!("the body starts with a paragraph");
    };
    let Some(XmlOut::Text(text)) = paragraph.get(&txn, 0) else {
        panic!("the paragraph starts with its text");
    };
    text
}

fn written_with_bold(doc: &Doc, text: &impl Text) -> String {
    let txn = doc.transact();
    let mut written = Vec::new();
    for chunk in text.diff(&txn, YChange::identity) {
        let piece = match chunk.insert {
            Out::Any(Any::String(letters)) => letters.to_string(),
            Out::YXmlElement(element) => element.tag().to_string(),
            other => panic!("unexpected item: {other:?}"),
        };
        let bold = chunk
            .attributes
            .is_some_and(|attrs| attrs.contains_key("bold"));
        let marker = if bold { "**" } else { "" };
        written.push(format!("{marker}{piece}{marker}"));
    }
    written.join(" ")
}

#[test]
fn removing_the_letter_before_an_unmarked_element_keeps_its_formatting_in_a_paragraph_text() {
    let doc = engine_doc();
    let body = doc.get_or_insert_xml_fragment("body");
    {
        let mut txn = doc.transact_mut();
        let paragraph = body.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        let text = paragraph.insert(&mut txn, 0, XmlTextPrelim::new(""));
        let image = XmlElementPrelim::empty("image");
        text.insert_with_attributes(&mut txn, 0, "ab", bold());
        text.insert_embed_with_attributes(&mut txn, 2, image, Attrs::new());
        text.insert_with_attributes(&mut txn, 3, "cd", bold());
    }
    let text = paragraph_text(&doc);
    assert_eq!(written_with_bold(&doc, &text), "**ab** image **cd**");
    let other = engine_doc();
    apply(&other, &encode(&doc));

    text.remove_range(&mut doc.transact_mut(), 1, 1);
    assert_eq!(written_with_bold(&doc, &text), "**a** image **cd**");

    let typed = paragraph_text(&other);
    typed.insert_with_attributes(&mut other.transact_mut(), 3, "x", Attrs::new());
    apply(&doc, &encode(&other));
    apply(&other, &encode(&doc));
    assert_eq!(written_with_bold(&doc, &text), "**a** image x **cd**");
    assert_eq!(written_with_bold(&other, &typed), "**a** image x **cd**");
}

#[test]
fn visits_each_live_item_as_it_is_stored_and_stops_at_the_first_error() {
    let doc = engine_doc();
    apply_yjs(&doc, "seed");
    apply_yjs(&doc, "join");
    let body = doc.get_or_insert_text(ROOT);
    let txn = doc.transact();
    let (mut letters, mut elements, mut formatting) = (String::new(), Vec::new(), Vec::new());
    body.try_visit_items(&txn, |item| -> Result<(), Infallible> {
        match item {
            TextItem::Letters(run) => letters.push_str(run),
            TextItem::Format(key, Any::Null) => formatting.push(format!("{key} off")),
            TextItem::Format(key, _) => formatting.push(format!("{key} on")),
            TextItem::Embed(Out::YXmlElement(stored)) => elements.push(stored.tag().to_string()),
            TextItem::Embed(_) | TextItem::Other => panic!("the seed holds no other item"),
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(letters, "OneTwox");
    assert_eq!(elements, ["block", "image"]);
    assert_eq!(formatting[..3], ["bold on", "bold off", "link on"]);

    let mut visited = 0;
    let stopped = body.try_visit_items(&txn, |_| {
        visited += 1;
        Err("stop")
    });
    assert_eq!(stopped, Err("stop"));
    assert_eq!(visited, 1);
}

fn stored_under(root: &impl AsRef<Branch>) -> (bool, bool) {
    let root = root.as_ref();
    (root.holds_unkeyed_item(), root.holds_keyed_item())
}

#[test]
fn tells_which_kinds_of_item_a_root_holds_also_once_they_are_deleted() {
    let doc = engine_doc();
    let text = doc.get_or_insert_text(ROOT);
    let records = doc.get_or_insert_map("containers");
    assert_eq!(stored_under(&text), (false, false));
    assert_eq!(stored_under(&records), (false, false));

    text.insert(&mut doc.transact_mut(), 0, "x");
    records.insert(&mut doc.transact_mut(), "key", "value");
    assert_eq!(stored_under(&text), (true, false));
    assert_eq!(stored_under(&records), (false, true));

    text.remove_range(&mut doc.transact_mut(), 0, 1);
    records.remove(&mut doc.transact_mut(), "key");
    assert_eq!(stored_under(&text), (true, false));
    assert_eq!(stored_under(&records), (false, true));
}

#[test]
fn reencodes_yjs_body() {
    let doc = engine_doc();
    apply_yjs(&doc, "seed");
    let peer = engine_doc();
    apply(&peer, &encode(&doc));
    assert_body(&peer, 10, seed_chunks("heading"));
}
