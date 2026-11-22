//! Reads a note body stored as one sequence (format 2) into the tree the
//! Markdown writer takes. The rules are sections 2 and 3 of
//! `docs/engineering/note-body-sequence.md`, and
//! `packages/ydoc-projection/src/fixtures/body-sequence.json` pins this reader
//! to the TypeScript one.

use super::*;
use std::sync::Arc;
use yrs::branch::Branch;
use yrs::types::text::TextItem;

const TOP: &str = "doc";
const BOUNDARY: &str = "block";
const PARAGRAPH: &str = "paragraph";
const MAX_PATH_ENTRIES: usize = 64;
const MAX_ID_BYTES: usize = 32;
const MAX_COLUMN_WIDTHS: usize = 1000;
const SAFE_INTEGER: u64 = (1 << 53) - 1;
const WHOLE_NUMBERS_END: f64 = (1_u64 << 63) as f64;

type Attributes = BTreeMap<String, Value>;
type Held = ProjectionResult<Option<Value>>;
type Path = Vec<(String, &'static str)>;
type Marks = Vec<MarkdownMark>;
type MarkAttributes = Arc<HashMap<String, Any>>;

const LEAVES: [&str; 6] = [
    PARAGRAPH,
    "heading",
    "codeBlock",
    "horizontalRule",
    "mathBlock",
    "rawBlock",
];

const INLINE_ITEMS: [&str; 7] = [
    "hardBreak",
    "image",
    "escapedPunctuation",
    "wikilink",
    "inlineAtom",
    "mathInline",
    "rawInline",
];

const CONTAINERS: [&str; 11] = [
    "blockquote",
    "callout",
    "bulletList",
    "orderedList",
    "taskList",
    "listItem",
    "taskItem",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
];

const MARKS: [(MarkKind, &str); 6] = [
    (MarkKind::Link, "link"),
    (MarkKind::Highlight, "highlight"),
    (MarkKind::Bold, "bold"),
    (MarkKind::Italic, "italic"),
    (MarkKind::Strike, "strike"),
    (MarkKind::Underline, "underline"),
];

#[derive(Clone, Copy)]
enum Holds {
    Text,
    TextOrNull,
    Line,
    LineOrNull,
    Bool,
    Whole(f64, f64),
    WholeOrNull(f64, f64),
    Fold,
    Side,
    Widths,
}

impl Holds {
    fn null(self) -> bool {
        let text = matches!(self, Holds::TextOrNull | Holds::LineOrNull);
        text || matches!(self, Holds::WholeOrNull(..) | Holds::Side | Holds::Widths)
    }
}

#[derive(Clone, Copy)]
enum Missing {
    Null,
    Text(&'static str),
    Whole(i64),
    False,
}

impl Missing {
    fn value(self) -> Value {
        match self {
            Missing::Null => Value::Null,
            Missing::Text(text) => json!(text),
            Missing::Whole(number) => json!(number),
            Missing::False => json!(false),
        }
    }
}

struct Attribute {
    name: &'static str,
    holds: Holds,
    missing: Missing,
}

const fn attribute(name: &'static str, holds: Holds, missing: Missing) -> Attribute {
    Attribute {
        name,
        holds,
        missing,
    }
}

const fn text(name: &'static str) -> Attribute {
    attribute(name, Holds::Text, Missing::Text(""))
}

const fn text_or_null(name: &'static str) -> Attribute {
    attribute(name, Holds::TextOrNull, Missing::Null)
}

const fn whole(name: &'static str, least: f64, most: f64, missing: i64) -> Attribute {
    attribute(name, Holds::Whole(least, most), Missing::Whole(missing))
}

const REL: &str = "noopener noreferrer nofollow";
const ROW_HEIGHT: Holds = Holds::WholeOrNull(1.0, 1_000_000.0);

const HEADING: &[Attribute] = &[whole("level", 1.0, 6.0, 1)];
const CODE_BLOCK: &[Attribute] = &[attribute("language", Holds::LineOrNull, Missing::Null)];
const TEX: &[Attribute] = &[text("tex")];
const SOURCE: &[Attribute] = &[text("source")];
const IMAGE: &[Attribute] = &[text("src"), text("alt"), text_or_null("title")];
const WIKILINK: &[Attribute] = &[text("target"), text_or_null("label")];
const ESCAPED_PUNCTUATION: &[Attribute] = &[text("value")];
const INLINE_ATOM: &[Attribute] = &[text("atomId"), text("params"), text("source")];
const CALLOUT: &[Attribute] = &[
    attribute("calloutType", Holds::Line, Missing::Text("note")),
    attribute("title", Holds::Line, Missing::Text("")),
    attribute("fold", Holds::Fold, Missing::Text("")),
];
const LOOSE: &[Attribute] = &[attribute("loose", Holds::Bool, Missing::Null)];
const ORDERED_LIST: &[Attribute] = &[
    whole("start", 0.0, 999_999_999.0, 1),
    text_or_null("type"),
    attribute("loose", Holds::Bool, Missing::Null),
];
const TASK_ITEM: &[Attribute] = &[attribute("checked", Holds::Bool, Missing::False)];
const TABLE_ROW: &[Attribute] = &[attribute("height", ROW_HEIGHT, Missing::Null)];
const TABLE_CELL: &[Attribute] = &[
    whole("colspan", 1.0, 1000.0, 1),
    whole("rowspan", 1.0, 1000.0, 1),
    attribute("colwidth", Holds::Widths, Missing::Null),
    attribute("align", Holds::Side, Missing::Null),
];
const LINK: &[Attribute] = &[
    text_or_null("href"),
    attribute("target", Holds::TextOrNull, Missing::Text("_blank")),
    attribute("rel", Holds::TextOrNull, Missing::Text(REL)),
    text_or_null("class"),
    text_or_null("title"),
];

fn attributes_of(kind: &str) -> &'static [Attribute] {
    match kind {
        "heading" => HEADING,
        "codeBlock" => CODE_BLOCK,
        "mathBlock" | "mathInline" => TEX,
        "rawBlock" | "rawInline" => SOURCE,
        "image" => IMAGE,
        "wikilink" => WIKILINK,
        "escapedPunctuation" => ESCAPED_PUNCTUATION,
        "inlineAtom" => INLINE_ATOM,
        "callout" => CALLOUT,
        "bulletList" | "taskList" => LOOSE,
        "orderedList" => ORDERED_LIST,
        "taskItem" => TASK_ITEM,
        "tableRow" => TABLE_ROW,
        "tableCell" | "tableHeader" => TABLE_CELL,
        "link" => LINK,
        _ => &[],
    }
}

fn known(names: &'static [&'static str], name: &str) -> Option<&'static str> {
    names.iter().copied().find(|known| *known == name)
}

fn only_child(parent: &str) -> Option<&'static str> {
    match parent {
        "bulletList" | "orderedList" => Some("listItem"),
        "taskList" => Some("taskItem"),
        "table" => Some("tableRow"),
        _ => None,
    }
}

fn holds_blocks(parent: &str) -> bool {
    matches!(
        parent,
        TOP | "blockquote" | "callout" | "listItem" | "taskItem" | "tableCell" | "tableHeader"
    )
}

fn block_container(container: &str) -> bool {
    matches!(
        container,
        "blockquote" | "callout" | "bulletList" | "orderedList" | "taskList" | "table"
    )
}

fn may_hold(parent: &str, container: &str) -> bool {
    if parent == "tableRow" {
        return matches!(container, "tableCell" | "tableHeader");
    }
    holds_blocks(parent) && block_container(container)
}

fn container_id(id: &str) -> bool {
    let letter = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-');
    (1..=MAX_ID_BYTES).contains(&id.len()) && id.bytes().all(letter)
}

fn is_one_line(text: &str) -> bool {
    !text.contains(['\n', '\r'])
}

fn is_fold(text: &str) -> bool {
    matches!(text, "" | "+" | "-")
}

fn is_side(text: &str) -> bool {
    matches!(text, "left" | "right" | "center")
}

fn plain(stored: Option<Out>) -> Option<Any> {
    match stored {
        Some(Out::Any(value)) => Some(value),
        _ => None,
    }
}

fn number(stored: &Any) -> Option<f64> {
    match stored {
        Any::Number(number) => Some(*number),
        Any::BigInt(integer) if integer.unsigned_abs() <= SAFE_INTEGER => Some(*integer as f64),
        _ => None,
    }
}

fn whole_in(stored: &Any, least: f64, most: f64) -> Option<Value> {
    number(stored)
        .filter(|number| number.fract() == 0.0 && (least..=most).contains(number))
        .map(|number| json!(number as i64))
}

fn width(stored: &Any) -> Option<Value> {
    let width = number(stored).filter(|width| width.is_finite() && *width >= 0.0)?;
    Some(whole_when_it_is(width))
}

fn whole_when_it_is(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < WHOLE_NUMBERS_END {
        json!(number as i64)
    } else {
        json!(number)
    }
}

fn element(tag: &str, attrs: Attributes, content: Vec<MarkdownNode>) -> MarkdownNode {
    MarkdownNode::Element {
        tag: tag.to_owned(),
        attrs,
        children: content,
    }
}

fn starts_with_paragraph(content: &[MarkdownNode]) -> bool {
    content.first().and_then(element_tag) == Some(PARAGRAPH)
}

fn push_letters(place: &mut Vec<MarkdownNode>, text: &str, marks: &[MarkdownMark]) {
    if !matches!(place.last(), Some(MarkdownNode::Text(_))) {
        place.push(MarkdownNode::Text(Vec::new()));
    }
    let Some(MarkdownNode::Text(runs)) = place.last_mut() else {
        return;
    };
    match runs.last_mut() {
        Some(run) if run.marks.as_slice() == marks => run.text.push_str(text),
        _ => runs.push(TextRun {
            text: text.to_owned(),
            marks: marks.to_vec(),
        }),
    }
}

#[derive(Default)]
struct Formatting {
    code: Option<MarkAttributes>,
    others: [Option<MarkAttributes>; MARKS.len()],
    read: Option<Marks>,
}

impl Formatting {
    fn store(&mut self, key: &str, value: &Any) {
        let mark = match key {
            "code" => &mut self.code,
            _ => match MARKS.iter().position(|(_, name)| *name == key) {
                Some(at) => &mut self.others[at],
                None => return,
            },
        };
        *mark = match value {
            Any::Map(attributes) => Some(attributes.clone()),
            _ => None,
        };
        self.read = None;
    }
}

struct Budget<'a> {
    nodes: &'a mut usize,
    bytes: &'a mut usize,
}

impl Budget<'_> {
    fn node(&mut self, depth: usize) -> ProjectionResult<()> {
        consume_projection_value_node(depth, self.nodes)
    }

    fn bytes(&mut self, length: usize) -> ProjectionResult<()> {
        *self.bytes = checked_projection_len(*self.bytes, length)?;
        Ok(())
    }

    fn string(&mut self, text: &str) -> Held {
        self.bytes(text.len())?;
        Ok(Some(json!(text)))
    }

    fn widths(&mut self, stored: &[Any], depth: usize) -> Held {
        let mut widths = Vec::new();
        for stored in stored {
            self.node(depth)?;
            match width(stored) {
                Some(width) => widths.push(width),
                None => return Ok(None),
            }
        }
        Ok(Some(Value::Array(widths)))
    }

    fn held(&mut self, stored: &Any, holds: Holds, depth: usize) -> Held {
        match (holds, stored) {
            (_, Any::Null) => Ok(holds.null().then_some(Value::Null)),
            (Holds::Text | Holds::TextOrNull, Any::String(text)) => self.string(text),
            (Holds::Line | Holds::LineOrNull, Any::String(text)) if is_one_line(text) => {
                self.string(text)
            }
            (Holds::Fold, Any::String(text)) if is_fold(text) => self.string(text),
            (Holds::Side, Any::String(text)) if is_side(text) => self.string(text),
            (Holds::Bool, Any::Bool(value)) => Ok(Some(json!(value))),
            (Holds::Whole(least, most) | Holds::WholeOrNull(least, most), stored) => {
                Ok(whole_in(stored, least, most))
            }
            (Holds::Widths, Any::Array(stored)) if stored.len() <= MAX_COLUMN_WIDTHS => {
                self.widths(stored, depth)
            }
            _ => Ok(None),
        }
    }

    fn attributes(
        &mut self,
        kind: &str,
        depth: usize,
        stored: impl Fn(&str) -> Option<Any>,
    ) -> ProjectionResult<Attributes> {
        let mut attributes = Attributes::new();
        for attribute in attributes_of(kind) {
            let held = match stored(attribute.name) {
                Some(stored) => {
                    self.node(depth)?;
                    self.held(&stored, attribute.holds, depth)?
                }
                None => None,
            };
            let value = held.unwrap_or_else(|| attribute.missing.value());
            attributes.insert(attribute.name.to_owned(), value);
        }
        Ok(attributes)
    }

    fn mark(
        &mut self,
        kind: MarkKind,
        name: &str,
        stored: &HashMap<String, Any>,
        depth: usize,
    ) -> ProjectionResult<MarkdownMark> {
        self.node(depth)?;
        let attrs = self.attributes(name, depth, |key| stored.get(key).cloned())?;
        Ok(MarkdownMark {
            kind,
            attrs: Value::Object(attrs.into_iter().collect()),
        })
    }

    fn marks(&mut self, stored: &Formatting, depth: usize) -> ProjectionResult<Marks> {
        if let Some(stored) = &stored.code {
            return Ok(vec![self.mark(MarkKind::Code, "code", stored, depth)?]);
        }
        let mut marks = Marks::new();
        for ((kind, name), stored) in MARKS.iter().zip(&stored.others) {
            if let Some(stored) = stored {
                marks.push(self.mark(*kind, name, stored, depth)?);
            }
        }
        Ok(marks)
    }
}

struct Open {
    id: String,
    tag: &'static str,
    attrs: Attributes,
    content: Vec<MarkdownNode>,
}

struct Leaf {
    tag: &'static str,
    attrs: Attributes,
    held: Vec<MarkdownNode>,
    after: Vec<MarkdownNode>,
}

impl Leaf {
    fn new(tag: &'static str, attrs: Attributes) -> Self {
        Leaf {
            tag,
            attrs,
            held: Vec::new(),
            after: Vec::new(),
        }
    }

    fn holds_letters(&self) -> bool {
        self.after.is_empty() && matches!(self.tag, PARAGRAPH | "heading" | "codeBlock")
    }

    fn holds_inline_items(&self) -> bool {
        self.after.is_empty() && matches!(self.tag, PARAGRAPH | "heading")
    }

    fn holds_letters_without_marks(&self) -> bool {
        self.tag == "codeBlock" && self.holds_letters()
    }
}

fn inline_place<'leaf>(
    leaf: &'leaf mut Option<Leaf>,
    budget: &mut Budget<'_>,
    holds: fn(&Leaf) -> bool,
    depth: usize,
) -> ProjectionResult<&'leaf mut Vec<MarkdownNode>> {
    if leaf.is_none() {
        budget.node(depth)?;
    }
    let leaf = leaf.get_or_insert_with(|| Leaf::new(PARAGRAPH, Attributes::new()));
    if holds(leaf) {
        return Ok(&mut leaf.held);
    }
    if leaf.after.is_empty() {
        budget.node(depth)?;
    }
    Ok(&mut leaf.after)
}

struct Reader<'a, T> {
    txn: &'a T,
    containers: &'a MapRef,
    budget: Budget<'a>,
    formatting: Formatting,
    top: Vec<MarkdownNode>,
    open: Vec<Open>,
    leaf: Option<Leaf>,
}

impl<T: ReadTxn> Reader<'_, T> {
    fn item(&mut self, stored: TextItem<'_>) -> ProjectionResult<()> {
        self.budget.node(self.open.len())?;
        match stored {
            TextItem::Letters(text) => self.letters(text),
            TextItem::Format(key, value) => {
                self.formatting.store(key, value);
                Ok(())
            }
            TextItem::Embed(Out::YXmlElement(stored)) => self.element(&stored),
            TextItem::Embed(_) | TextItem::Other => Ok(()),
        }
    }

    fn letters(&mut self, text: &str) -> ProjectionResult<()> {
        if text.is_empty() {
            return Ok(());
        }
        let depth = self.open.len() + 1;
        self.budget.bytes(text.len())?;
        let unmarked = match &self.leaf {
            Some(leaf) => leaf.holds_letters_without_marks(),
            None => false,
        };
        if !unmarked && self.formatting.read.is_none() {
            let read = self.budget.marks(&self.formatting, depth)?;
            self.formatting.read = Some(read);
        }
        let marks: &[MarkdownMark] = match &self.formatting.read {
            Some(marks) if !unmarked => marks,
            _ => &[],
        };
        let holds = Leaf::holds_letters;
        let place = inline_place(&mut self.leaf, &mut self.budget, holds, depth)?;
        push_letters(place, text, marks);
        Ok(())
    }

    fn element(&mut self, stored: &yrs::XmlElementRef) -> ProjectionResult<()> {
        if stored.tag().as_ref() == BOUNDARY {
            return self.boundary(stored);
        }
        let Some(tag) = known(&INLINE_ITEMS, stored.tag()) else {
            return Ok(());
        };
        let txn = self.txn;
        let depth = self.open.len() + 1;
        self.budget.bytes(tag.len())?;
        let held = |name: &str| plain(stored.get_attribute(txn, name));
        let attrs = self.budget.attributes(tag, depth, held)?;
        let holds = Leaf::holds_inline_items;
        let place = inline_place(&mut self.leaf, &mut self.budget, holds, depth)?;
        place.push(element(tag, attrs, Vec::new()));
        Ok(())
    }

    fn boundary(&mut self, stored: &yrs::XmlElementRef) -> ProjectionResult<()> {
        self.close_leaf();
        let txn = self.txn;
        let containers = self.containers;
        let held = |name: &str| plain(stored.get_attribute(txn, name));
        let tag = match held("type") {
            Some(Any::String(name)) => known(&LEAVES, &name).unwrap_or(PARAGRAPH),
            _ => PARAGRAPH,
        };
        let mut path = self.path(held("path"))?;
        while path.last().is_some_and(|(_, kind)| !holds_blocks(kind)) {
            path.pop();
        }
        let shared = self
            .open
            .iter()
            .zip(&path)
            .take_while(|(open, (id, kind))| open.id == *id && open.tag == *kind)
            .count();
        self.close_to(shared)?;
        for (id, kind) in path.into_iter().skip(shared) {
            let depth = self.open.len();
            self.budget.node(depth)?;
            self.budget.bytes(kind.len())?;
            let record = |name: &str| plain(containers.get(txn, &format!("{id}.{name}")));
            let attrs = self.budget.attributes(kind, depth, record)?;
            self.open.push(Open {
                id,
                tag: kind,
                attrs,
                content: Vec::new(),
            });
        }
        let depth = self.open.len();
        self.budget.bytes(tag.len())?;
        let attrs = self.budget.attributes(tag, depth, held)?;
        self.leaf = Some(Leaf::new(tag, attrs));
        Ok(())
    }

    fn path(&mut self, stored: Option<Any>) -> ProjectionResult<Path> {
        let mut path = Path::new();
        let Some(Any::Array(entries)) = stored else {
            return Ok(path);
        };
        let mut parent = TOP;
        for entry in entries.iter().take(MAX_PATH_ENTRIES) {
            self.budget.node(path.len())?;
            let Any::String(id) = entry else { break };
            if !container_id(id) || path.iter().any(|(used, _)| **used == **id) {
                break;
            }
            let Some(Any::String(recorded)) = plain(self.containers.get(self.txn, id)) else {
                break;
            };
            let kind = match only_child(parent) {
                Some(kind) => kind,
                None => match known(&CONTAINERS, &recorded) {
                    Some(kind) if may_hold(parent, kind) => kind,
                    _ => break,
                },
            };
            self.budget.bytes(id.len())?;
            path.push((id.to_string(), kind));
            parent = kind;
        }
        Ok(path)
    }

    fn place(&mut self) -> &mut Vec<MarkdownNode> {
        match self.open.last_mut() {
            Some(open) => &mut open.content,
            None => &mut self.top,
        }
    }

    fn close_leaf(&mut self) {
        if let Some(leaf) = self.leaf.take() {
            let place = self.place();
            place.push(element(leaf.tag, leaf.attrs, leaf.held));
            if !leaf.after.is_empty() {
                place.push(element(PARAGRAPH, Attributes::new(), leaf.after));
            }
        }
    }

    fn close_to(&mut self, depth: usize) -> ProjectionResult<()> {
        while self.open.len() > depth {
            let Some(mut closed) = self.open.pop() else {
                return Ok(());
            };
            let item = matches!(closed.tag, "listItem" | "taskItem");
            if item && !starts_with_paragraph(&closed.content) {
                self.budget.node(self.open.len())?;
                let paragraph = element(PARAGRAPH, Attributes::new(), Vec::new());
                closed.content.insert(0, paragraph);
            }
            let node = element(closed.tag, closed.attrs, closed.content);
            self.place().push(node);
        }
        Ok(())
    }

    fn finish(mut self) -> ProjectionResult<Vec<MarkdownNode>> {
        self.close_leaf();
        self.close_to(0)?;
        if self.top.is_empty() {
            self.budget.node(0)?;
            let paragraph = element(PARAGRAPH, Attributes::new(), Vec::new());
            self.top.push(paragraph);
        }
        Ok(self.top)
    }
}

pub(super) fn roots_hold_only_their_own_items(
    body: &impl AsRef<Branch>,
    sequence: &impl AsRef<Branch>,
    containers: &impl AsRef<Branch>,
) -> bool {
    let (body, sequence, containers) = (body.as_ref(), sequence.as_ref(), containers.as_ref());
    !body.holds_unkeyed_item()
        && !body.holds_keyed_item()
        && !sequence.holds_keyed_item()
        && !containers.holds_unkeyed_item()
}

pub(super) fn blocks<T: ReadTxn>(
    txn: &T,
    sequence: &yrs::TextRef,
    containers: &MapRef,
    remaining_nodes: &mut usize,
    source_text_bytes: &mut usize,
) -> ProjectionResult<Vec<MarkdownNode>> {
    let mut reader = Reader {
        txn,
        containers,
        budget: Budget {
            nodes: remaining_nodes,
            bytes: source_text_bytes,
        },
        formatting: Formatting::default(),
        top: Vec::new(),
        open: Vec::new(),
        leaf: None,
    };
    sequence.try_visit_items(txn, |stored| reader.item(stored))?;
    reader.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const NOTES: &str =
        include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence.json");
    const DELETES_FIRST_UNIT: [u8; 6] = [0, 1, 5, 1, 0, 1];
    const TYPES_BETWEEN_UNITS: [u8; 12] = [1, 1, 6, 0, 0xc4, 5, 0, 5, 1, 1, b'y', 0];
    const TWO_TO_THE_53: f64 = 9_007_199_254_740_992.0;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Note {
        name: String,
        update: String,
        document: Value,
        markdown: Option<String>,
        markdown_not_compared: Option<String>,
    }

    fn notes() -> Vec<Note> {
        use serde::Deserialize as _;
        let mut json = serde_json::Deserializer::from_str(NOTES);
        json.disable_recursion_limit();
        Vec::deserialize(&mut json).expect("the shared notes parse")
    }

    fn stored(note: &Note) -> Ydoc {
        let doc = Ydoc::wire().reading_body_sequence();
        let update = base64::engine::general_purpose::STANDARD
            .decode(&note.update)
            .expect("the note's update is base64");
        doc.apply(&update).expect("the note's update applies");
        doc
    }

    fn note_of(write: impl FnOnce(&mut yrs::TransactionMut<'_>, &yrs::TextRef)) -> Ydoc {
        let doc = Ydoc::with_client_id(5).reading_body_sequence();
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        {
            let mut txn = doc.doc.transact_mut();
            write(&mut txn, &sequence);
            meta.insert(&mut txn, "schemaVersion", Any::Number(2.0));
        }
        doc
    }

    fn empty_note() -> Ydoc {
        note_of(|_, _| {})
    }

    fn insert_boundary(
        txn: &mut yrs::TransactionMut<'_>,
        sequence: &yrs::TextRef,
        kind: &str,
        path: &[&str],
    ) {
        let at = sequence.len(txn);
        let stored = sequence.insert_embed(txn, at, XmlElementPrelim::empty(BOUNDARY));
        let path: Vec<Any> = path.iter().map(|id| Any::from(*id)).collect();
        stored.insert_attribute(txn, "type", Any::from(kind));
        stored.insert_attribute(txn, "path", Any::from(path));
    }

    fn written_elsewhere(write: impl FnOnce(&Doc)) -> Vec<u8> {
        let elsewhere = Ydoc::wire();
        write(&elsewhere.doc);
        elsewhere.encode_full_state()
    }

    fn var_uint(bytes: &mut Vec<u8>, mut value: usize) {
        while value > 0x7f {
            bytes.push(0x80 | (value & 0x7f) as u8);
            value >>= 7;
        }
        bytes.push(value as u8);
    }

    fn var_string(bytes: &mut Vec<u8>, text: &str) {
        var_uint(bytes, text.len());
        bytes.extend_from_slice(text.as_bytes());
    }

    fn formatting_items_under_keys_that_are_no_marks(count: usize) -> Vec<u8> {
        const CLIENT: usize = 9;
        const FORMAT: u8 = 6;
        const HAS_ORIGIN: u8 = 0x80;
        let mut update = Vec::new();
        var_uint(&mut update, 1);
        var_uint(&mut update, count);
        var_uint(&mut update, CLIENT);
        var_uint(&mut update, 0);
        for clock in 0..count {
            if clock == 0 {
                update.push(FORMAT);
                var_uint(&mut update, 1);
                var_string(&mut update, ROOT_SEQUENCE);
            } else {
                update.push(HAS_ORIGIN | FORMAT);
                var_uint(&mut update, CLIENT);
                var_uint(&mut update, clock - 1);
            }
            var_string(&mut update, &format!("key{clock}"));
            var_string(&mut update, "true");
        }
        var_uint(&mut update, 0);
        update
    }

    fn read(doc: &Ydoc, nodes: &mut usize) -> ProjectionResult<Vec<MarkdownNode>> {
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let txn = doc.doc.transact();
        let mut bytes = 0;
        blocks(&txn, &sequence, &containers, nodes, &mut bytes)
    }

    fn document(doc: &Ydoc) -> ProjectionResult<Value> {
        let mut nodes = MAX_PROJECTION_NODES;
        let blocks = read(doc, &mut nodes)?;
        Ok(json!({ "type": TOP, "content": shown(&blocks) }))
    }

    fn nodes_spent(doc: &Ydoc) -> usize {
        let mut nodes = MAX_PROJECTION_NODES;
        read(doc, &mut nodes).expect("the note reads");
        MAX_PROJECTION_NODES - nodes
    }

    fn admitted(doc: &Ydoc) -> Result<(), CollabError> {
        doc.validate_public_baseline(&doc.encode_full_state())
    }

    fn too_complex<T>(read: Result<T, CollabError>) -> bool {
        matches!(read, Err(CollabError::ProjectionTooComplex { .. }))
    }

    fn shown(nodes: &[MarkdownNode]) -> Vec<Value> {
        let mut shown_nodes = Vec::new();
        for node in nodes {
            match node {
                MarkdownNode::Text(runs) => shown_nodes.extend(runs.iter().map(shown_run)),
                MarkdownNode::Fragment(content) => shown_nodes.extend(shown(content)),
                MarkdownNode::Element {
                    tag,
                    attrs,
                    children,
                } => {
                    let mut shown_node = serde_json::Map::new();
                    shown_node.insert("type".to_owned(), json!(tag));
                    if !attrs.is_empty() {
                        shown_node.insert("attrs".to_owned(), json!(attrs));
                    }
                    if !children.is_empty() {
                        shown_node.insert("content".to_owned(), Value::Array(shown(children)));
                    }
                    shown_nodes.push(Value::Object(shown_node));
                }
            }
        }
        shown_nodes
    }

    fn shown_run(run: &TextRun) -> Value {
        if run.marks.is_empty() {
            return json!({ "type": "text", "text": run.text });
        }
        let marks: Vec<Value> = run.marks.iter().map(shown_mark).collect();
        json!({ "type": "text", "text": run.text, "marks": marks })
    }

    fn shown_mark(mark: &MarkdownMark) -> Value {
        let name = match mark.kind {
            MarkKind::Link => "link",
            MarkKind::Highlight => "highlight",
            MarkKind::Bold => "bold",
            MarkKind::Code => "code",
            MarkKind::Italic => "italic",
            MarkKind::Strike => "strike",
            MarkKind::Underline => "underline",
        };
        if mark.attrs == json!({}) {
            json!({ "type": name })
        } else {
            json!({ "type": name, "attrs": mark.attrs })
        }
    }

    fn same_document(recorded: &Value, here: &Value) -> bool {
        match (recorded, here) {
            (Value::Number(recorded), Value::Number(here)) => recorded.as_f64() == here.as_f64(),
            (Value::Array(recorded), Value::Array(here)) => {
                let same = |(recorded, here): (&Value, &Value)| same_document(recorded, here);
                recorded.len() == here.len() && recorded.iter().zip(here).all(same)
            }
            (Value::Object(recorded), Value::Object(here)) => {
                let same = |(key, recorded): (&String, &Value)| match here.get(key) {
                    Some(here) => same_document(recorded, here),
                    None => false,
                };
                recorded.len() == here.len() && recorded.iter().all(same)
            }
            _ => recorded == here,
        }
    }

    fn top_blocks(document: &Value) -> Vec<Value> {
        match &document["content"] {
            Value::Array(blocks) => blocks.clone(),
            _ => Vec::new(),
        }
    }

    fn lines(markdown: &str) -> Vec<String> {
        markdown.split('\n').map(str::to_owned).collect()
    }

    fn differing<T: ToString>(recorded: &[T], here: &[T], same: fn(&T, &T) -> bool) -> String {
        let mut differing = Vec::new();
        for at in 0..recorded.len().max(here.len()) {
            let (recorded, here) = (recorded.get(at), here.get(at));
            let alike = match (recorded, here) {
                (Some(recorded), Some(here)) => same(recorded, here),
                _ => false,
            };
            if !alike {
                differing.push(format!(
                    "  {at} recorded: {:?}\n  {at} here:     {:?}",
                    recorded.map(ToString::to_string),
                    here.map(ToString::to_string)
                ));
            }
        }
        differing.join("\n")
    }

    fn difference(note: &Note, what: &str, differing: &str) -> String {
        format!("{}: these {what} differ\n{differing}", note.name)
    }

    #[test]
    fn reads_every_shared_note_as_its_document_and_writes_its_markdown_byte_for_byte() {
        let notes = notes();
        assert!(notes.len() >= 20, "the shared notes are all there");
        let same_line = |recorded: &String, here: &String| recorded == here;
        let mut differences = Vec::new();
        for note in &notes {
            let doc = stored(note);
            match document(&doc) {
                Ok(read) if same_document(&note.document, &read) => {}
                Ok(read) => {
                    let (recorded, here) = (top_blocks(&note.document), top_blocks(&read));
                    let blocks = differing(&recorded, &here, same_document);
                    differences.push(difference(note, "blocks of the document", &blocks));
                }
                Err(error) => differences.push(format!("{}: {error}", note.name)),
            }
            let written = doc.project(ContentKind::Richdoc);
            match (&note.markdown, &note.markdown_not_compared, written) {
                (Some(recorded), None, Ok(written)) if written.content == *recorded => {}
                (Some(recorded), None, Ok(written)) => {
                    let (recorded, here) = (lines(recorded), lines(&written.content));
                    let lines = differing(&recorded, &here, same_line);
                    differences.push(difference(note, "lines of the Markdown", &lines));
                }
                (None, Some(_), Ok(_)) => {}
                (_, _, Err(error)) => differences.push(format!("{}: {error}", note.name)),
                _ => differences.push(format!(
                    "{}: records its Markdown or why it is not compared, never both",
                    note.name
                )),
            }
        }
        assert!(differences.is_empty(), "{}", differences.join("\n\n"));
    }

    #[test]
    fn writes_a_whole_number_whole_and_compares_a_recorded_number_by_its_value() {
        assert_eq!(whole_when_it_is(-0.0), json!(0));
        assert_eq!(whole_when_it_is(TWO_TO_THE_53), json!(1_i64 << 53));
        assert!(same_document(&json!(1e21), &whole_when_it_is(1e21)));
        assert!(same_document(&json!(20.5), &whole_when_it_is(20.5)));
        assert!(same_document(&json!([2]), &json!([2.0])));
        assert!(!same_document(&json!([1]), &json!([2])));
        assert!(!same_document(&json!([1]), &json!([1, 1])));
    }

    #[test]
    fn is_admitted_as_a_baseline_only_by_a_document_that_reads_sequences() {
        for note in notes() {
            let doc = stored(&note);
            let baseline = doc.encode_full_state();
            doc.validate_public_baseline(&baseline)
                .unwrap_or_else(|error| panic!("{}: {error}", note.name));
            doc.project(ContentKind::Richdoc)
                .unwrap_or_else(|error| panic!("{}: {error}", note.name));
            doc.validate_public_baseline(&baseline)
                .unwrap_or_else(|error| panic!("{} once written: {error}", note.name));

            let unaware = Ydoc::wire();
            unaware.apply(&baseline).expect("the note applies");
            let refused = unaware.validate_public_baseline(&baseline).is_err();
            assert!(refused, "{}", note.name);
        }
    }

    #[test]
    fn writes_the_body_root_as_before_when_the_document_does_not_read_sequences() {
        let note = &notes()[0];
        let unaware = Ydoc::wire();
        unaware
            .apply(&stored(note).encode_full_state())
            .expect("the note applies");
        unaware.richdoc_append_paragraph("under body");
        let written = unaware.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "under body\n");
    }

    #[test]
    fn refuses_a_sequence_note_that_holds_any_item_under_body() {
        let note = empty_note();
        assert!(admitted(&note).is_ok());
        note.richdoc_append_paragraph("under body");
        assert!(admitted(&note).is_err());

        let note = empty_note();
        note.richdoc_append_paragraph("under body");
        note.richdoc_remove_block(0);
        assert!(admitted(&note).is_err());

        let note = empty_note();
        let keyed = written_elsewhere(|doc| {
            let body = doc.get_or_insert_map(ROOT_BODY);
            body.insert(&mut doc.transact_mut(), "key", Any::from("value"));
        });
        note.apply(&keyed).expect("the item applies");
        assert!(admitted(&note).is_err());
    }

    #[test]
    fn refuses_a_sequence_that_holds_a_keyed_item() {
        let note = empty_note();
        let keyed = written_elsewhere(|doc| {
            let sequence = doc.get_or_insert_map(ROOT_SEQUENCE);
            sequence.insert(&mut doc.transact_mut(), "key", Any::from("value"));
        });
        note.apply(&keyed).expect("the item applies");
        assert!(admitted(&note).is_err());
    }

    #[test]
    fn refuses_containers_that_hold_an_unkeyed_item() {
        let note = empty_note();
        let unkeyed = written_elsewhere(|doc| {
            let containers = doc.get_or_insert_array(ROOT_CONTAINERS);
            containers.push_back(&mut doc.transact_mut(), Any::from("value"));
        });
        note.apply(&unkeyed).expect("the item applies");
        assert!(admitted(&note).is_err());
    }

    #[test]
    fn refuses_sequence_roots_on_a_note_whose_body_is_under_body() {
        let doc = Ydoc::wire().reading_body_sequence();
        doc.richdoc_append_paragraph("under body");
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        meta.insert(
            &mut doc.doc.transact_mut(),
            "schemaVersion",
            Any::Number(1.0),
        );
        admitted(&doc).expect("a note whose body is under body is admitted as before");
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "under body\n");

        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        sequence.insert(&mut doc.doc.transact_mut(), 0, "letters");
        assert!(admitted(&doc).is_err());
    }

    #[test]
    fn refuses_a_change_or_a_baseline_that_splits_a_letter_of_two_units() {
        let splits_a_letter = |base: &Ydoc, change: &[u8]| {
            let refused = crate::validate_replay_parity(base, change);
            matches!(refused, Err(CollabError::ReplayParityViolation { .. }))
        };
        let note = note_of(|txn, sequence| sequence.insert(txn, 0, "\u{1f600}X"));
        assert!(admitted(&note).is_ok());
        assert!(splits_a_letter(&note, &DELETES_FIRST_UNIT));
        assert!(splits_a_letter(&note, &TYPES_BETWEEN_UNITS));

        let letter_and_delete = [note.encode_full_state(), DELETES_FIRST_UNIT.to_vec()];
        let baseline = merge_updates(&letter_and_delete).expect("they merge");
        let empty = Ydoc::wire().reading_body_sequence();
        assert!(splits_a_letter(&empty, &baseline));
    }

    #[test]
    fn writes_frontmatter_above_a_sequence_body() {
        let note = &notes()[0];
        let markdown = note.markdown.as_deref().expect("it is recorded");
        let doc = stored(note);
        let frontmatter = doc.doc.get_or_insert_map(ROOT_FRONTMATTER);
        frontmatter.insert(&mut doc.doc.transact_mut(), "title", "Plan");
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        let expected = format!("---\ntitle: Plan\n---\n\n{markdown}");
        assert_eq!(written.content, expected);
    }

    #[test]
    fn stops_at_the_node_budget() {
        let doc = stored(&notes()[0]);
        let spent = nodes_spent(&doc);
        assert!(too_complex(doc.project_richdoc_with_node_budget(spent - 1)));
        assert!(doc.project_richdoc_with_node_budget(spent).is_ok());
    }

    #[test]
    fn spends_a_node_for_a_stored_item_it_skips() {
        let note = note_of(|txn, sequence| {
            sequence.insert_embed(txn, 0, Any::from("an embedded string"));
            sequence.insert_embed(txn, 1, XmlElementPrelim::empty("nonsense"));
        });
        assert_eq!(nodes_spent(&note), 3);
    }

    #[test]
    fn spends_a_node_for_a_formatting_item_under_a_key_that_is_no_mark() {
        let note = empty_note();
        let items = formatting_items_under_keys_that_are_no_marks(1_000);
        note.apply(&items).expect("the items apply");
        assert_eq!(nodes_spent(&note), 1_001);
        assert!(too_complex(note.project_richdoc_with_node_budget(1_000)));
        let written = note.project_richdoc_with_node_budget(1_001);
        assert_eq!(written.expect("it writes"), "");
    }

    #[test]
    fn refuses_a_note_of_more_formatting_items_than_the_node_budget() {
        let note = empty_note();
        let items = formatting_items_under_keys_that_are_no_marks(MAX_PROJECTION_NODES + 1);
        note.apply(&items).expect("the items apply");
        assert!(too_complex(note.project(ContentKind::Richdoc)));
    }

    #[test]
    fn spends_a_node_for_each_paragraph_it_adds() {
        assert_eq!(nodes_spent(&empty_note()), 1);

        let before_any_boundary = note_of(|txn, sequence| sequence.insert(txn, 0, "x"));
        assert_eq!(nodes_spent(&before_any_boundary), 2);

        let rule = note_of(|txn, sequence| {
            insert_boundary(txn, sequence, "horizontalRule", &[]);
        });
        let letters_after_a_rule = note_of(|txn, sequence| {
            insert_boundary(txn, sequence, "horizontalRule", &[]);
            sequence.insert(txn, 1, "x");
        });
        assert_eq!(nodes_spent(&letters_after_a_rule), nodes_spent(&rule) + 2);

        let first_in_an_item = |kind: &'static str| {
            let note = note_of(|txn, sequence| {
                insert_boundary(txn, sequence, kind, &["L", "i"]);
            });
            let containers = note.doc.get_or_insert_map(ROOT_CONTAINERS);
            {
                let mut txn = note.doc.transact_mut();
                containers.insert(&mut txn, "L", Any::from("bulletList"));
                containers.insert(&mut txn, "i", Any::from("listItem"));
            }
            nodes_spent(&note)
        };
        let heading_first = first_in_an_item("heading");
        assert_eq!(heading_first, first_in_an_item("paragraph") + 1);
    }
}
