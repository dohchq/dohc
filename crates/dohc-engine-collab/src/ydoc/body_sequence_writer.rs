//! Writes a new note body as one sequence (format 2), the way
//! `writeNewBody` in `packages/ydoc-projection/src/bodySequenceWriter.ts`
//! does: section 4 of `docs/engineering/note-body-sequence.md`.

use super::body_sequence::{self, BOUNDARY, CONTAINERS, INLINE_ITEMS, LEAVES, MAX_PATH_ENTRIES};
use super::*;
use yrs::block::{ItemContent, Prelim, Unused};
use yrs::branch::{Branch, BranchPtr};
use yrs::types::text::TextItem;
use yrs::types::{Attrs, Delta, TypeRef};

const MAX_STRUCT_VISITS: usize = 400_000;
const MAX_VALUE_NODE_VISITS: usize = 5_000_000;
const MAX_DECODED_PAYLOAD_BYTE_VISITS: usize = 100_000_000;
const SAVE_VISITS_PER_STRUCT: usize = 4;
const SAVE_VISITS_PER_VALUE: usize = 7;
const LIVE_NOTE_CAPACITY: usize = 280_000;
const LIVE_NOTE_ELEMENT_WEIGHT: usize = 6;
const SHA256_HEX_BYTES: usize = 64;

const KINDS_A_CONTAINER_CAN_BECOME: [&[&str]; 4] = [
    &["blockquote", "callout"],
    &["bulletList", "orderedList", "taskList"],
    &["listItem", "taskItem"],
    &["tableCell", "tableHeader"],
];

pub(super) enum Piece {
    Letters(String),
    Element {
        tag: &'static str,
        attributes: BTreeMap<&'static str, Any>,
    },
}

impl Prelim for Piece {
    type Return = Unused;

    fn into_content(self, _txn: &mut yrs::TransactionMut) -> (ItemContent, Option<Self>) {
        let tag = match &self {
            Piece::Letters(text) => return (ItemContent::String(text.as_str().into()), None),
            Piece::Element { tag, .. } => *tag,
        };
        let element = Branch::new(TypeRef::XmlElement(tag.into()));
        (ItemContent::Type(element), Some(self))
    }

    fn integrate(self, txn: &mut yrs::TransactionMut, inner_ref: BranchPtr) {
        if let Piece::Element { attributes, .. } = self {
            let element = yrs::XmlElementRef::from(inner_ref);
            for (key, value) in attributes {
                element.insert_attribute(txn, key, value);
            }
        }
    }
}

#[derive(Default)]
pub(super) struct NewBody {
    pieces: Vec<Delta<Piece>>,
    records: Vec<(String, Any)>,
    containers: usize,
}

pub(super) fn new_body(body: &[MarkdownNode]) -> Option<NewBody> {
    let mut written = NewBody::default();
    written.blocks(body, &mut Vec::new())?;
    Some(written)
}

pub(super) fn write(
    txn: &mut yrs::TransactionMut,
    sequence: &yrs::TextRef,
    containers: &MapRef,
    body: NewBody,
) {
    for (key, value) in body.records {
        containers.insert(txn, key, value);
    }
    sequence.apply_delta(txn, body.pieces);
}

fn stored(kind: &str, given: impl Fn(&str) -> Option<Value>) -> BTreeMap<&'static str, Any> {
    body_sequence::written_attributes(kind, given)
        .map(|(name, value)| (name, json_to_any(&value)))
        .collect()
}

fn mark_name(kind: MarkKind) -> &'static str {
    match kind {
        MarkKind::Link => "link",
        MarkKind::Highlight => "highlight",
        MarkKind::Bold => "bold",
        MarkKind::Code => "code",
        MarkKind::Italic => "italic",
        MarkKind::Strike => "strike",
        MarkKind::Underline => "underline",
    }
}

fn marks_of(run: &TextRun) -> Attrs {
    run.marks
        .iter()
        .map(|mark| {
            let name = mark_name(mark.kind);
            let attributes = stored(name, |key| mark.attrs.get(key).cloned());
            let value = attributes
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect::<HashMap<_, _>>();
            (Arc::from(name), Any::from(value))
        })
        .collect()
}

impl NewBody {
    fn blocks(&mut self, nodes: &[MarkdownNode], path: &mut Vec<String>) -> Option<()> {
        for node in nodes {
            match node {
                MarkdownNode::Fragment(children) => self.blocks(children, path)?,
                MarkdownNode::Element {
                    tag,
                    attrs,
                    children,
                } => match (
                    body_sequence::known(&LEAVES, tag),
                    body_sequence::known(&CONTAINERS, tag),
                ) {
                    (Some(leaf), _) => self.leaf(leaf, attrs, children, path)?,
                    (None, Some(container)) if path.len() < MAX_PATH_ENTRIES => {
                        let id = base_36(self.containers);
                        self.containers += 1;
                        self.records(&id, container, attrs);
                        path.push(id);
                        let pieces = self.pieces.len();
                        self.blocks(children, path)?;
                        if self.pieces.len() == pieces {
                            return None;
                        }
                        path.pop();
                    }
                    _ => return None,
                },
                MarkdownNode::Text(_) => return None,
            }
        }
        Some(())
    }

    fn records(&mut self, id: &str, kind: &'static str, attrs: &BTreeMap<String, Value>) {
        let mut records = stored(kind, |name| attrs.get(name).cloned());
        let family = KINDS_A_CONTAINER_CAN_BECOME
            .iter()
            .find(|family| family.contains(&kind))
            .map_or(&[][..], |family| *family);
        for other in family {
            for (name, value) in stored(other, |_| None) {
                records.entry(name).or_insert(value);
            }
        }
        self.records.push((id.to_owned(), Any::from(kind)));
        for (name, value) in records {
            self.records.push((format!("{id}.{name}"), value));
        }
    }

    fn leaf(
        &mut self,
        tag: &'static str,
        attrs: &BTreeMap<String, Value>,
        children: &[MarkdownNode],
        path: &[String],
    ) -> Option<()> {
        let mut attributes = stored(tag, |name| attrs.get(name).cloned());
        attributes.insert("type", Any::from(tag));
        let ids: Vec<Any> = path.iter().map(|id| Any::from(id.as_str())).collect();
        attributes.insert("path", Any::from(ids));
        let boundary = Piece::Element {
            tag: BOUNDARY,
            attributes,
        };
        self.pieces.push(Delta::Inserted(boundary, None));
        for child in children {
            self.inline(child)?;
        }
        Some(())
    }

    fn inline(&mut self, node: &MarkdownNode) -> Option<()> {
        match node {
            MarkdownNode::Text(runs) => {
                for run in runs.iter().filter(|run| !run.text.is_empty()) {
                    let marks = Some(Box::new(marks_of(run)));
                    let letters = Piece::Letters(run.text.clone());
                    self.pieces.push(Delta::Inserted(letters, marks));
                }
            }
            MarkdownNode::Element {
                tag,
                attrs,
                children,
            } if children.is_empty() => {
                let tag = body_sequence::known(&INLINE_ITEMS, tag)?;
                let attributes = stored(tag, |name| attrs.get(name).cloned());
                let item = Piece::Element { tag, attributes };
                self.pieces.push(Delta::Inserted(item, None));
            }
            _ => return None,
        }
        Some(())
    }
}

fn base_36(mut number: usize) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((number % 36) as u32, 36).unwrap_or('0'));
        number /= 36;
        if number == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Weight {
    structs: usize,
    elements: usize,
    values: usize,
    bytes: usize,
}

impl Weight {
    pub(super) fn of(doc: &Doc) -> Self {
        for name in [ROOT_META, ROOT_FRONTMATTER, ROOT_CONTAINERS] {
            doc.get_or_insert_map(name);
        }
        doc.get_or_insert_text(ROOT_SEQUENCE);
        let txn = doc.transact();
        let mut weight = Weight::default();
        for (name, root) in txn.root_refs() {
            match root {
                Out::YMap(map) => {
                    for (key, value) in map.iter(&txn) {
                        weight.item(name.len() + key.len());
                        weight.out(value);
                    }
                }
                Out::YText(text) => {
                    let _ = text.try_visit_items(&txn, |item| {
                        weight.text_item(&txn, name.len(), item);
                        Ok::<(), ()>(())
                    });
                }
                _ => {}
            }
        }
        weight
    }

    fn item(&mut self, bytes: usize) {
        self.structs += 1;
        self.values += 1;
        self.bytes += bytes;
    }

    fn text_item<T: ReadTxn>(&mut self, txn: &T, root_bytes: usize, item: TextItem<'_>) {
        match item {
            TextItem::Letters(text) => self.item(root_bytes + text.len()),
            TextItem::Format(key, value) => {
                self.item(root_bytes + key.len());
                self.any(value);
            }
            TextItem::Embed(Out::YXmlElement(element)) => {
                self.item(root_bytes + element.tag().len());
                self.elements += 1;
                for (key, value) in element.attributes(txn) {
                    self.item(key.len());
                    self.out(value);
                }
            }
            TextItem::Embed(embedded) => {
                self.item(root_bytes);
                self.out(embedded);
            }
            TextItem::Other => self.item(root_bytes),
        }
    }

    fn out(&mut self, value: Out) {
        match value {
            Out::Any(value) => self.any(&value),
            _ => self.values += 1,
        }
    }

    fn any(&mut self, value: &Any) {
        self.values += 1;
        match value {
            Any::String(text) => self.bytes += text.len(),
            Any::Buffer(bytes) => self.bytes += bytes.len(),
            Any::Array(values) => values.iter().for_each(|value| self.any(value)),
            Any::Map(values) => {
                for (key, value) in values.iter() {
                    self.bytes += key.len();
                    self.any(value);
                }
            }
            _ => {}
        }
    }

    pub(super) fn with_room_for_a_kept_source(mut self, markdown: &str) -> Self {
        let keys = [
            MARKDOWN_SOURCE_META_KEY,
            MARKDOWN_SOURCE_SHA_META_KEY,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
        ];
        self.structs += keys.len();
        self.values += keys.len();
        self.bytes += markdown.len() + 2 * SHA256_HEX_BYTES;
        self.bytes += keys
            .iter()
            .map(|key| ROOT_META.len() + key.len())
            .sum::<usize>();
        self
    }

    pub(super) fn fits_a_live_note(&self) -> bool {
        SAVE_VISITS_PER_STRUCT * self.structs <= MAX_STRUCT_VISITS
            && self.structs + LIVE_NOTE_ELEMENT_WEIGHT * self.elements <= LIVE_NOTE_CAPACITY
            && SAVE_VISITS_PER_VALUE * self.values <= MAX_VALUE_NODE_VISITS
            && SAVE_VISITS_PER_VALUE * self.bytes <= MAX_DECODED_PAYLOAD_BYTE_VISITS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const WRITTEN_NOTES: &str = include_str!(
        "../../../../packages/ydoc-projection/src/fixtures/body-sequence-written.json"
    );
    const POLICY: &str =
        include_str!("../../../../packages/ydoc-projection/src/liveValidationPolicy.ts");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WrittenNote {
        name: String,
        update: String,
        structs: usize,
        elements: usize,
        value_node_visits: usize,
        decoded_payload_byte_visits: usize,
    }

    fn written_notes() -> Vec<WrittenNote> {
        serde_json::from_str(WRITTEN_NOTES).expect("the written notes parse")
    }

    fn opened(update: &str) -> Ydoc {
        let doc = Ydoc::wire().reading_body_sequence();
        let update = base64::engine::general_purpose::STANDARD
            .decode(update)
            .expect("the note's update is base64");
        doc.apply(&update).expect("the note's update applies");
        doc
    }

    fn read(doc: &Ydoc) -> Vec<MarkdownNode> {
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let txn = doc.doc.transact();
        let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
        body_sequence::blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes)
            .expect("the note reads")
    }

    fn written(body: &[MarkdownNode]) -> Ydoc {
        let doc = Ydoc::with_client_id(9).reading_body_sequence();
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        let body = new_body(body).expect("the note can be written");
        let mut txn = doc.doc.transact_mut();
        meta.insert(&mut txn, "schemaVersion", Any::Number(2.0));
        write(&mut txn, &sequence, &containers, body);
        drop(txn);
        doc
    }

    #[test]
    fn writes_each_note_the_typescript_writer_wrote_so_it_reads_and_projects_the_same() {
        let notes = written_notes();
        assert_eq!(notes.len(), 23);
        for note in notes {
            let stored = opened(&note.update);
            let body = read(&stored);
            let again = written(&body);
            assert_eq!(
                format!("{:?}", read(&again)),
                format!("{body:?}"),
                "{}",
                note.name
            );
            assert_eq!(
                markdown_document(&read(&again)).expect("the written note projects"),
                markdown_document(&body).expect("the stored note projects"),
                "{}",
                note.name
            );
        }
    }

    #[test]
    fn counts_the_structs_and_elements_the_relay_counts_and_at_least_its_values_and_bytes() {
        for note in written_notes() {
            let weight = Weight::of(&opened(&note.update).doc);
            assert_eq!(
                (weight.structs, weight.elements),
                (note.structs, note.elements),
                "{}",
                note.name
            );
            assert!(weight.values >= note.value_node_visits, "{}", note.name);
            assert!(
                weight.bytes >= note.decoded_payload_byte_visits,
                "{}",
                note.name
            );
        }
    }

    #[test]
    fn checks_a_note_against_the_relay_policy_typescript_declares() {
        for declared in [
            "maxStructVisits: 400_000,",
            "maxValueNodeVisits: 5_000_000,",
            "maxDecodedPayloadByteVisits: 100_000_000,",
            "LIVE_NOTE_CAPACITY = 280_000;",
            "LIVE_NOTE_ELEMENT_WEIGHT = 6;",
            "maxStructVisits: 4,",
            "maxValueNodeVisits: 7,",
            "maxDecodedPayloadByteVisits: 7,",
            "SAVE_VISITS_OUTSIDE_A_MARK = 4;",
        ] {
            assert!(POLICY.contains(declared), "{declared}");
        }
        let at_most = |weight: Weight| weight.fits_a_live_note();
        let structs = Weight {
            structs: MAX_STRUCT_VISITS / SAVE_VISITS_PER_STRUCT,
            ..Weight::default()
        };
        assert!(at_most(structs));
        let structs = Weight {
            structs: MAX_STRUCT_VISITS / SAVE_VISITS_PER_STRUCT + 1,
            ..Weight::default()
        };
        assert!(!at_most(structs));
        let elements = Weight {
            structs: 40_000,
            elements: 40_001,
            ..Weight::default()
        };
        assert!(!at_most(elements));
        let values = Weight {
            values: MAX_VALUE_NODE_VISITS / SAVE_VISITS_PER_VALUE + 1,
            ..Weight::default()
        };
        assert!(!at_most(values));
        let bytes = Weight {
            bytes: MAX_DECODED_PAYLOAD_BYTE_VISITS / SAVE_VISITS_PER_VALUE + 1,
            ..Weight::default()
        };
        assert!(!at_most(bytes));
    }

    fn reading_of(markdown: &str) -> Vec<MarkdownNode> {
        let (blocks, refused) = parse_markdown_blocks_checked(markdown, MarkdownReading::Successor);
        assert!(!refused, "{markdown}");
        let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
        read_blocks::<true>(&blocks, &mut nodes, &mut bytes).expect("the note reads")
    }

    #[test]
    fn writes_to_a_sequence_that_came_through_an_update() {
        let first = written(&reading_of("- a\n- b\n"));
        let second = Ydoc::with_client_id(10).reading_body_sequence();
        second
            .apply(&first.encode_full_state())
            .expect("the note applies");
        let sequence = second.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = second.doc.get_or_insert_map(ROOT_CONTAINERS);
        let heading = new_body(&reading_of("# Title\n")).expect("the heading can be written");
        let edit = second.with_delta(|txn| write(txn, &sequence, &containers, heading));
        let third = Ydoc::wire().reading_body_sequence();
        third
            .apply(&first.encode_full_state())
            .expect("the note applies");
        third.apply(&edit).expect("the edit applies");
        let expected = markdown_document(&reading_of("# Title\n\n- a\n- b\n")).expect("projects");
        for doc in [&second, &third] {
            assert_eq!(markdown_document(&read(doc)).expect("projects"), expected);
        }
    }

    #[test]
    fn reads_a_written_list_alike_though_it_left_out_attributes_that_default_to_null() {
        for note in ["- a\n- b\n", "1. one\n2. two\n"] {
            let body = reading_of(note);
            assert!(same_reading(&read(&written(&body)), &body), "{note}");
        }
        let ordered = |start: i64| MarkdownNode::Element {
            tag: "orderedList".to_owned(),
            attrs: BTreeMap::from([("start".to_owned(), Value::from(start))]),
            children: Vec::new(),
        };
        assert!(!same_reading(&[ordered(1)], &[ordered(2)]));
    }

    #[test]
    fn writes_nothing_for_a_note_with_no_block() {
        let doc = written(&[]);
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let txn = doc.doc.transact();
        assert_eq!(sequence.len(&txn), 0);
        assert_eq!(containers.len(&txn), 0);
    }

    #[test]
    fn refuses_a_line_in_more_containers_than_a_note_holds() {
        let paragraph = || MarkdownNode::Element {
            tag: "paragraph".to_owned(),
            attrs: BTreeMap::new(),
            children: Vec::new(),
        };
        let quoted = |depth: usize| {
            (0..depth).fold(paragraph(), |inner, _| MarkdownNode::Element {
                tag: "blockquote".to_owned(),
                attrs: BTreeMap::new(),
                children: vec![inner],
            })
        };
        assert!(new_body(&[quoted(MAX_PATH_ENTRIES)]).is_some());
        assert!(new_body(&[quoted(MAX_PATH_ENTRIES + 1)]).is_none());
    }

    #[test]
    fn names_containers_by_their_number_in_base_36() {
        let names: Vec<String> = [0, 9, 10, 35, 36, 1295, 1296].map(base_36).into();
        assert_eq!(names, ["0", "9", "a", "z", "10", "zz", "100"]);
    }
}
