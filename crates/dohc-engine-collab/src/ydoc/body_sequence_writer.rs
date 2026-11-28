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
const MAX_INDEX_OPERATIONS: usize = 100_000_000;
const INDEX_OPERATIONS_PER_NOTE: usize = 50_000;
const INDEX_OPERATIONS_PER_STRUCT_SEARCH: usize = 31;
const INDEX_OPERATIONS_PER_STRUCT: usize = 370;
const INDEX_OPERATIONS_PER_ROOT_ENTRY: usize = 80;
const KEY_SORT_PASSES: usize = 3;
const INDEX_OPERATIONS_PER_ASTRAL_SEARCH: usize = 5;
const INDEX_OPERATIONS_PER_BOUNDARY_SEARCH: usize = 4;
const SHA256_HEX_BYTES: usize = 64;
const TRAILING_LINE_STRUCTS: usize = 3;

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
    pub(super) pieces: Vec<Delta<Piece>>,
    pub(super) records: Vec<(String, Any)>,
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

pub(super) fn stored(
    kind: &str,
    given: impl Fn(&str) -> Option<Value>,
) -> BTreeMap<&'static str, Any> {
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

pub(super) fn marks_of(marks: &[MarkdownMark]) -> Attrs {
    marks
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
                    let marks = Some(Box::new(marks_of(&run.marks)));
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

pub(super) fn same_family(kind: &str, other: &str) -> bool {
    kind == other
        || KINDS_A_CONTAINER_CAN_BECOME
            .iter()
            .any(|family| family.contains(&kind) && family.contains(&other))
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
    root_entries: usize,
    key_sorts: usize,
    astral: usize,
}

fn log2_up(count: usize) -> usize {
    (usize::BITS - count.saturating_sub(1).leading_zeros()) as usize
}

fn needs_a_shared_type(value: &Any) -> bool {
    match value {
        Any::Array(values) => values.iter().any(needs_a_shared_type),
        Any::Map(values) => {
            values.contains_key("constructor")
                || values.contains_key("__proto__")
                || values.values().any(needs_a_shared_type)
        }
        _ => false,
    }
}

fn shared_structs(value: &Any) -> usize {
    match value {
        Any::BigInt(_) => 1,
        Any::Map(values) => values.values().map(|value| 1 + shared_structs(value)).sum(),
        Any::Array(values) => {
            let mut packed = false;
            values
                .iter()
                .map(|value| match value {
                    Any::Map(_) | Any::Array(_) | Any::BigInt(_) | Any::Buffer(_) => {
                        packed = false;
                        1 + shared_structs(value)
                    }
                    _ => usize::from(!std::mem::replace(&mut packed, true)),
                })
                .sum()
        }
        _ => 0,
    }
}

fn escaped_in_a_shared_map(key: &str) -> bool {
    key.starts_with('$') && key.trim_start_matches('$') == "dohcBigInt"
}

fn key_sorts(value: &Any, shared: bool) -> usize {
    match value {
        Any::Array(values) => values.iter().map(|value| key_sorts(value, shared)).sum(),
        Any::Map(values) => {
            let longest = values
                .keys()
                .map(|key| key.len() + usize::from(shared && escaped_in_a_shared_map(key)))
                .max()
                .unwrap_or(0);
            let held: usize = values.values().map(|value| key_sorts(value, shared)).sum();
            held + match values.len() {
                keys @ 0..=1 => keys,
                keys => keys * log2_up(keys) * (longest + 3),
            }
        }
        Any::BigInt(_) if shared => 1,
        _ => 0,
    }
}

#[derive(Default)]
struct Run {
    marks: HashMap<String, Any>,
    counted: Option<HashMap<String, Any>>,
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
                        weight.root_entries += 1;
                        weight.item(name.len() + key.len());
                        let shared = name == ROOT_FRONTMATTER
                            && matches!(&value, Out::Any(value) if needs_a_shared_type(value));
                        weight.out(value, shared);
                    }
                }
                Out::YText(text) => {
                    let mut run = Run::default();
                    let _ = text.try_visit_items(&txn, |item| {
                        weight.text_item(&txn, name.len(), item, &mut run);
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

    fn text_item<T: ReadTxn>(
        &mut self,
        txn: &T,
        root_bytes: usize,
        item: TextItem<'_>,
        run: &mut Run,
    ) {
        match item {
            TextItem::Letters(text) => {
                self.values += 1;
                self.bytes += root_bytes + text.len();
                self.astral += text.bytes().filter(|byte| *byte >= 0xF0).count();
                if run.counted.as_ref() != Some(&run.marks) {
                    self.structs += 1 + 2 * run.marks.len();
                    self.key_sorts += run
                        .marks
                        .values()
                        .map(|value| key_sorts(value, false))
                        .sum::<usize>();
                    run.counted = Some(run.marks.clone());
                }
            }
            TextItem::Format(key, value) => {
                self.values += 1;
                self.bytes += root_bytes + key.len();
                self.any(value);
                match value {
                    Any::Null => run.marks.remove(key),
                    value => run.marks.insert(key.to_owned(), value.clone()),
                };
            }
            TextItem::Embed(Out::YXmlElement(element)) => {
                run.counted = None;
                self.item(root_bytes + element.tag().len());
                self.elements += 1;
                for (key, value) in element.attributes(txn) {
                    self.item(key.len());
                    self.out(value, false);
                }
            }
            TextItem::Embed(embedded) => {
                run.counted = None;
                self.item(root_bytes);
                self.out(embedded, false);
            }
            TextItem::Other => {
                run.counted = None;
                self.item(root_bytes);
            }
        }
    }

    fn out(&mut self, value: Out, shared: bool) {
        match value {
            Out::Any(value) => {
                if shared {
                    self.structs += shared_structs(&value);
                }
                self.key_sorts += key_sorts(&value, shared);
                self.any(&value);
            }
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

    pub(super) fn with_room_for_a_trailing_line(mut self) -> Self {
        self.structs += TRAILING_LINE_STRUCTS;
        self
    }

    pub(super) fn with_room_for_a_kept_source(mut self, markdown: &str) -> Self {
        let keys = [
            MARKDOWN_SOURCE_META_KEY,
            MARKDOWN_SOURCE_SHA_META_KEY,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
        ];
        self.structs += keys.len();
        self.root_entries += keys.len();
        self.values += keys.len();
        self.bytes += markdown.len() + 2 * SHA256_HEX_BYTES;
        self.bytes += keys
            .iter()
            .map(|key| ROOT_META.len() + key.len())
            .sum::<usize>();
        self
    }

    pub(super) fn index_operations(&self) -> usize {
        let operations = INDEX_OPERATIONS_PER_NOTE
            + INDEX_OPERATIONS_PER_STRUCT_SEARCH * self.structs * log2_up(self.structs.max(2))
            + INDEX_OPERATIONS_PER_STRUCT * self.structs.saturating_sub(self.root_entries)
            + INDEX_OPERATIONS_PER_ROOT_ENTRY * self.root_entries
            + KEY_SORT_PASSES * self.key_sorts
            + INDEX_OPERATIONS_PER_ASTRAL_SEARCH * self.astral * log2_up(self.astral)
            + INDEX_OPERATIONS_PER_BOUNDARY_SEARCH * (self.structs + 1) * log2_up(self.astral);
        (operations * 11).div_ceil(10)
    }

    pub(super) fn fits_a_live_note(&self) -> Result<(), Overweight> {
        let structs = SAVE_VISITS_PER_STRUCT * self.structs;
        let weight = self.structs + LIVE_NOTE_ELEMENT_WEIGHT * self.elements;
        let values = SAVE_VISITS_PER_VALUE * self.values;
        let bytes = SAVE_VISITS_PER_VALUE * self.bytes;
        [
            (
                "maxStructVisits",
                "struct visits",
                structs,
                MAX_STRUCT_VISITS,
            ),
            ("liveNoteCapacity", "weight", weight, LIVE_NOTE_CAPACITY),
            (
                "maxValueNodeVisits",
                "value visits",
                values,
                MAX_VALUE_NODE_VISITS,
            ),
            (
                "maxDecodedPayloadByteVisits",
                "byte visits",
                bytes,
                MAX_DECODED_PAYLOAD_BYTE_VISITS,
            ),
            (
                "maxIndexOperations",
                "index operations",
                self.index_operations(),
                MAX_INDEX_OPERATIONS,
            ),
        ]
        .into_iter()
        .find(|&(_, _, used, max)| used > max)
        .map_or(Ok(()), |(limit, unit, used, max)| {
            Err(Overweight {
                limit,
                unit,
                used,
                max,
            })
        })
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
    const FIT: &str =
        include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-fit.json");

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
    fn counts_structs_and_elements_as_typescript_writes_an_upper_bound_when_runs_share_marks() {
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
    fn counts_a_frontmatter_value_as_typescript_stores_it() {
        let number = |value: f64| Any::Number(value);
        let list = |values: &[Any]| Any::from(values.to_vec());
        let map = |entries: &[(&str, Any)]| {
            Any::from(
                entries
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), value.clone()))
                    .collect::<HashMap<_, _>>(),
            )
        };
        for (value, structs, key_sorts) in [
            (
                list(&[
                    number(1.0),
                    number(2.0),
                    list(&[number(3.0), number(4.0)]),
                    map(&[("a", number(1.0))]),
                    Any::BigInt(5),
                    Any::from("x"),
                    map(&[("constructor", number(1.0))]),
                ]),
                10,
                3,
            ),
            (
                map(&[
                    ("constructor", number(1.0)),
                    (
                        "plain",
                        map(&[("x", number(1.0)), ("y", list(&[number(1.0), number(2.0)]))]),
                    ),
                    ("big", Any::BigInt(7)),
                    ("$dohcBigInt", number(1.0)),
                ]),
                4,
                128,
            ),
            (
                map(&[("a", map(&[("constructor", map(&[("b", number(1.0))]))]))]),
                2,
                3,
            ),
            (
                list(&[
                    list(&[
                        number(1.0),
                        list(&[number(2.0), map(&[("k", number(1.0)), ("kk", number(2.0))])]),
                    ]),
                    Any::BigInt(9),
                ]),
                0,
                10,
            ),
            (
                list(&[map(&[
                    ("$dohcBigInt", number(1.0)),
                    ("$$dohcBigInt", number(2.0)),
                    ("constructor", number(1.0)),
                ])]),
                4,
                96,
            ),
        ] {
            let doc = Doc::new();
            let frontmatter = doc.get_or_insert_map(ROOT_FRONTMATTER);
            frontmatter.insert(&mut doc.transact_mut(), "v", value.clone());
            let weight = Weight::of(&doc);
            assert_eq!(
                (weight.structs, weight.key_sorts),
                (1 + structs, key_sorts),
                "{value:?}"
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
        let at_most = |weight: Weight| weight.fits_a_live_note().is_ok();
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

    #[test]
    fn counts_the_index_operations_typescript_counts_and_names_the_first_limit_a_note_passes() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Bound {
            structs: usize,
            root_entries: usize,
            key_sorts: usize,
            astral: usize,
            index_operations: usize,
        }
        #[derive(serde::Deserialize)]
        struct Fit {
            bounds: Vec<Bound>,
        }
        let fit: Fit = serde_json::from_str(FIT).expect("the fit fixture parses");
        assert_eq!(fit.bounds.len(), 8);
        for bound in fit.bounds {
            let weight = Weight {
                structs: bound.structs,
                root_entries: bound.root_entries,
                key_sorts: bound.key_sorts,
                astral: bound.astral,
                ..Weight::default()
            };
            assert_eq!(weight.index_operations(), bound.index_operations);
        }
        let over = |weight: Weight| weight.fits_a_live_note().unwrap_err();
        let structs = Weight {
            structs: MAX_STRUCT_VISITS / SAVE_VISITS_PER_STRUCT + 1,
            ..Weight::default()
        };
        assert_eq!(
            over(structs),
            Overweight {
                limit: "maxStructVisits",
                unit: "struct visits",
                used: MAX_STRUCT_VISITS + SAVE_VISITS_PER_STRUCT,
                max: MAX_STRUCT_VISITS,
            }
        );
        let sorted = |key_sorts| Weight {
            key_sorts,
            ..Weight::default()
        };
        assert!(sorted(30_286_363).fits_a_live_note().is_ok());
        assert_eq!(
            over(sorted(30_286_364)),
            Overweight {
                limit: "maxIndexOperations",
                unit: "index operations",
                used: 100_000_002,
                max: MAX_INDEX_OPERATIONS,
            }
        );
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
