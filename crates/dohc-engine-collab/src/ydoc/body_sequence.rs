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

#[cfg(test)]
thread_local! {
    static MARK_VALUES_COMPARED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

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
    !text.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn is_fold(text: &str) -> bool {
    matches!(text, "" | "+" | "-")
}

fn is_side(text: &str) -> bool {
    matches!(text, "left" | "right" | "center")
}

pub(super) fn stored_under(holder: &impl AsRef<Branch>, key: &str) -> Option<Any> {
    holder.as_ref().stored_value(key)
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

struct ReadMarks {
    marks: Marks,
    nodes: usize,
    bytes: usize,
    generation: u64,
}

#[derive(Default)]
struct Formatting {
    code: Option<MarkAttributes>,
    others: [Option<MarkAttributes>; MARKS.len()],
    read: Option<ReadMarks>,
    generation: u64,
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
        self.generation += 1;
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
            (Holds::Line | Holds::LineOrNull, Any::String(text)) => {
                Ok(self.string(text)?.filter(|_| is_one_line(text)))
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

    fn read_marks(&mut self, stored: &Formatting, depth: usize) -> ProjectionResult<ReadMarks> {
        let (mut nodes, bytes) = (MAX_PROJECTION_NODES, *self.bytes);
        let mut reading = Budget {
            nodes: &mut nodes,
            bytes: self.bytes,
        };
        let marks = reading.marks(stored, depth)?;
        Ok(ReadMarks {
            marks,
            nodes: MAX_PROJECTION_NODES - nodes,
            bytes: *self.bytes - bytes,
            generation: stored.generation,
        })
    }

    fn copy_of(&mut self, read: &ReadMarks, depth: usize) -> ProjectionResult<Marks> {
        for _ in 0..read.nodes {
            self.node(depth)?;
        }
        self.bytes(read.bytes)?;
        Ok(read.marks.clone())
    }

    fn joins(
        &mut self,
        run: &TextRun,
        read: Option<&ReadMarks>,
        newest_run: Option<u64>,
    ) -> ProjectionResult<bool> {
        let Some(read) = read else {
            return Ok(run.marks.is_empty());
        };
        if newest_run == Some(read.generation) {
            return Ok(true);
        }
        if run.marks.len() != read.marks.len() {
            return Ok(false);
        }
        self.bytes(read.bytes)?;
        #[cfg(test)]
        MARK_VALUES_COMPARED.with(|count| count.set(count.get() + 1));
        Ok(run.marks == read.marks)
    }

    fn letters(
        &mut self,
        place: &mut Vec<MarkdownNode>,
        text: &str,
        read: Option<&ReadMarks>,
        newest_run: &mut Option<u64>,
        depth: usize,
    ) -> ProjectionResult<()> {
        if !matches!(place.last(), Some(MarkdownNode::Text(_))) {
            place.push(MarkdownNode::Text(Vec::new()));
        }
        let Some(MarkdownNode::Text(runs)) = place.last_mut() else {
            return Ok(());
        };
        let generation = read.map(|read| read.generation);
        if let Some(run) = runs.last_mut() {
            if self.joins(run, read, *newest_run)? {
                run.text.push_str(text);
                *newest_run = generation;
                return Ok(());
            }
        }
        self.node(depth)?;
        let marks = match read {
            Some(read) => self.copy_of(read, depth)?,
            None => Marks::new(),
        };
        runs.push(TextRun {
            text: text.to_owned(),
            marks,
        });
        *newest_run = generation;
        Ok(())
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

struct Reader<'a> {
    containers: &'a MapRef,
    budget: Budget<'a>,
    formatting: Formatting,
    top: Vec<MarkdownNode>,
    open: Vec<Open>,
    leaf: Option<Leaf>,
    newest_run: Option<u64>,
}

impl Reader<'_> {
    fn item(&mut self, stored: TextItem<'_>) -> ProjectionResult<()> {
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
            let read = self.budget.read_marks(&self.formatting, depth)?;
            self.formatting.read = Some(read);
        }
        let read = self.formatting.read.as_ref().filter(|_| !unmarked);
        let holds = Leaf::holds_letters;
        let place = inline_place(&mut self.leaf, &mut self.budget, holds, depth)?;
        let newest_run = &mut self.newest_run;
        self.budget.letters(place, text, read, newest_run, depth)
    }

    fn element(&mut self, stored: &yrs::XmlElementRef) -> ProjectionResult<()> {
        if stored.tag().as_ref() == BOUNDARY {
            return self.boundary(stored);
        }
        let Some(tag) = known(&INLINE_ITEMS, stored.tag()) else {
            return Ok(());
        };
        let depth = self.open.len() + 1;
        self.budget.node(depth)?;
        self.budget.bytes(tag.len())?;
        let held = |name: &str| stored_under(stored, name);
        let attrs = self.budget.attributes(tag, depth, held)?;
        let holds = Leaf::holds_inline_items;
        let place = inline_place(&mut self.leaf, &mut self.budget, holds, depth)?;
        place.push(element(tag, attrs, Vec::new()));
        Ok(())
    }

    fn boundary(&mut self, stored: &yrs::XmlElementRef) -> ProjectionResult<()> {
        self.close_leaf();
        let containers = self.containers;
        let held = |name: &str| stored_under(stored, name);
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
            let record = |name: &str| stored_under(containers, &format!("{id}.{name}"));
            let attrs = self.budget.attributes(kind, depth, record)?;
            self.open.push(Open {
                id,
                tag: kind,
                attrs,
                content: Vec::new(),
            });
        }
        let depth = self.open.len();
        self.budget.node(depth)?;
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
            let Some(Any::String(recorded)) = stored_under(self.containers, id) else {
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

pub(super) fn holds_the_body(sequence: &impl AsRef<Branch>, body: &impl AsRef<Branch>) -> bool {
    sequence.as_ref().holds_unkeyed_item() || !body.as_ref().holds_unkeyed_item()
}

pub(super) fn blocks<T: ReadTxn>(
    txn: &T,
    sequence: &yrs::TextRef,
    containers: &MapRef,
    remaining_nodes: &mut usize,
    source_text_bytes: &mut usize,
) -> ProjectionResult<Vec<MarkdownNode>> {
    let mut reader = Reader {
        containers,
        budget: Budget {
            nodes: remaining_nodes,
            bytes: source_text_bytes,
        },
        formatting: Formatting::default(),
        top: Vec::new(),
        open: Vec::new(),
        leaf: None,
        newest_run: None,
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
    const EDITED_NOTE: &str =
        include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-edited.json");
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

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StoredItems {
        live: usize,
        nodes_at_most: usize,
    }

    #[derive(serde::Deserialize)]
    struct EditedNote {
        update: String,
        document: Value,
        stored: StoredItems,
    }

    fn notes() -> Vec<Note> {
        use serde::Deserialize as _;
        let mut json = serde_json::Deserializer::from_str(NOTES);
        json.disable_recursion_limit();
        Vec::deserialize(&mut json).expect("the shared notes parse")
    }

    fn stored(note: &Note) -> Ydoc {
        opened(&note.update)
    }

    fn opened(update: &str) -> Ydoc {
        let doc = Ydoc::wire().reading_body_sequence();
        let update = base64::engine::general_purpose::STANDARD
            .decode(update)
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

    #[derive(Clone)]
    enum Stored {
        Format(String, String),
        Letters(&'static str),
        Element(&'static str),
    }

    fn sequence_of(items: &[Stored]) -> Vec<u8> {
        const CLIENT: usize = 9;
        const HAS_ORIGIN: u8 = 0x80;
        const XML_ELEMENT: u8 = 3;
        let mut update = Vec::new();
        var_uint(&mut update, 1);
        var_uint(&mut update, items.len());
        var_uint(&mut update, CLIENT);
        var_uint(&mut update, 0);
        let mut clock = 0;
        for item in items {
            let content: u8 = match item {
                Stored::Letters(_) => 4,
                Stored::Format(..) => 6,
                Stored::Element(_) => 7,
            };
            if clock == 0 {
                update.push(content);
                var_uint(&mut update, 1);
                var_string(&mut update, ROOT_SEQUENCE);
            } else {
                update.push(HAS_ORIGIN | content);
                var_uint(&mut update, CLIENT);
                var_uint(&mut update, clock - 1);
            }
            match item {
                Stored::Letters(text) => {
                    var_string(&mut update, text);
                    clock += text.encode_utf16().count();
                }
                Stored::Format(key, value) => {
                    var_string(&mut update, key);
                    var_string(&mut update, value);
                    clock += 1;
                }
                Stored::Element(name) => {
                    update.push(XML_ELEMENT);
                    var_string(&mut update, name);
                    clock += 1;
                }
            }
        }
        var_uint(&mut update, 0);
        update
    }

    fn formatting_items_under_keys_that_are_no_marks(count: usize) -> Vec<u8> {
        let mut items = Vec::new();
        for at in 0..count {
            items.push(Stored::Format(format!("key{at}"), "true".to_owned()));
        }
        sequence_of(&items)
    }

    fn read(
        doc: &Ydoc,
        nodes: &mut usize,
        bytes: &mut usize,
    ) -> ProjectionResult<Vec<MarkdownNode>> {
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let txn = doc.doc.transact();
        blocks(&txn, &sequence, &containers, nodes, bytes)
    }

    fn document(doc: &Ydoc) -> ProjectionResult<Value> {
        let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
        let blocks = read(doc, &mut nodes, &mut bytes)?;
        Ok(json!({ "type": TOP, "content": shown(&blocks) }))
    }

    fn spent(doc: &Ydoc) -> (usize, usize) {
        let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
        read(doc, &mut nodes, &mut bytes).expect("the note reads");
        (MAX_PROJECTION_NODES - nodes, bytes)
    }

    fn nodes_spent(doc: &Ydoc) -> usize {
        spent(doc).0
    }

    fn live_items(doc: &Ydoc) -> usize {
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let txn = doc.doc.transact();
        let mut live = 0;
        let counted = sequence.try_visit_items(&txn, |_| -> ProjectionResult<()> {
            live += 1;
            Ok(())
        });
        counted.expect("counting never fails");
        live
    }

    fn items_in_texts<T: ReadTxn>(txn: &T, node: XmlOut, held: &mut usize, other: &mut usize) {
        match node {
            XmlOut::Text(text) => {
                let counted = text.try_visit_items(txn, |stored| -> ProjectionResult<()> {
                    match stored {
                        TextItem::Letters(_) | TextItem::Format(..) => *held += 1,
                        TextItem::Embed(_) | TextItem::Other => *other += 1,
                    }
                    Ok(())
                });
                counted.expect("counting never fails");
            }
            XmlOut::Element(element) => {
                for child in element.children(txn) {
                    items_in_texts(txn, child, held, other);
                }
            }
            XmlOut::Fragment(fragment) => {
                for child in fragment.children(txn) {
                    items_in_texts(txn, child, held, other);
                }
            }
        }
    }

    fn admitted(doc: &Ydoc) -> Result<(), CollabError> {
        doc.validate_public_baseline(&doc.encode_full_state())
    }

    fn too_large<T>(read: Result<T, CollabError>) -> bool {
        matches!(read, Err(CollabError::ProjectionTooLarge { .. }))
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
        stops_one_node_short_of(&doc, nodes_spent(&doc));
    }

    fn stops_one_node_short_of(note: &Ydoc, nodes: usize) {
        assert_eq!(nodes_spent(note), nodes);
        let stopped = note.project_richdoc_with_node_budget(nodes - 1);
        let Err(CollabError::ProjectionTooComplex { nodes_left, .. }) = stopped else {
            panic!("it reads with one node fewer");
        };
        assert_eq!(nodes_left, 0);
        assert!(note.project_richdoc_with_node_budget(nodes).is_ok());
    }

    fn stops_one_byte_short_of(note: &Ydoc, bytes: usize) {
        assert_eq!(spent(note).1, bytes);
        let with_bytes_left = |left: usize| {
            let mut nodes = MAX_PROJECTION_NODES;
            let mut used = MAX_PROJECTION_BYTES - left;
            read(note, &mut nodes, &mut used)
        };
        assert!(too_large(with_bytes_left(bytes - 1)));
        assert!(with_bytes_left(bytes).is_ok());
    }

    fn mark_values_compared(note: &Ydoc) -> usize {
        MARK_VALUES_COMPARED.with(|count| count.set(0));
        spent(note);
        MARK_VALUES_COMPARED.with(|count| count.get())
    }

    fn linked(href: &str, after_the_link: &[Stored]) -> Ydoc {
        let link = format!("{{\"href\":\"{href}\"}}");
        let mut items = vec![Stored::Format("link".to_owned(), link)];
        items.extend_from_slice(after_the_link);
        let note = empty_note();
        note.apply(&sequence_of(&items)).expect("the items apply");
        note
    }

    #[test]
    fn spends_nothing_for_a_stored_item_it_skips() {
        let note = note_of(|txn, sequence| {
            sequence.insert_embed(txn, 0, Any::from("an embedded string"));
            sequence.insert_embed(txn, 1, XmlElementPrelim::empty("nonsense"));
        });
        assert_eq!(live_items(&note), 2);
        stops_one_node_short_of(&note, 1);
    }

    #[test]
    fn reads_many_stored_items_that_make_one_text_run_with_three_nodes() {
        let mut items = Vec::new();
        for at in 0..1_000 {
            items.push(Stored::Format(format!("key{at}"), "true".to_owned()));
            items.push(Stored::Format("bold".to_owned(), "{}".to_owned()));
            items.push(Stored::Format("italic".to_owned(), "{}".to_owned()));
            items.push(Stored::Format("italic".to_owned(), "null".to_owned()));
            items.push(Stored::Element("nonsense"));
            items.push(Stored::Letters("x"));
        }
        let note = empty_note();
        note.apply(&sequence_of(&items)).expect("the items apply");
        assert_eq!(live_items(&note), 6_000);
        let (paragraph, run, its_copy_of_bold) = (1, 1, 1);
        stops_one_node_short_of(&note, paragraph + run + its_copy_of_bold);

        let letters = "x".repeat(1_000);
        let run = json!({ "type": "text", "text": letters, "marks": [{ "type": "bold" }] });
        let paragraph = json!({ "type": PARAGRAPH, "content": [run] });
        let read = document(&note).expect("the note reads");
        assert_eq!(read, json!({ "type": TOP, "content": [paragraph] }));
    }

    #[test]
    fn reads_a_note_of_more_formatting_items_than_the_node_budget() {
        let note = empty_note();
        let items = formatting_items_under_keys_that_are_no_marks(MAX_PROJECTION_NODES + 1);
        note.apply(&items).expect("the items apply");
        assert_eq!(nodes_spent(&note), 1);
        let written = note.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "");
    }

    #[test]
    fn spends_nodes_for_each_text_run_that_alternating_marks_make() {
        let mut items = Vec::new();
        for _ in 0..100 {
            items.push(Stored::Format("bold".to_owned(), "{}".to_owned()));
            items.push(Stored::Letters("x"));
            items.push(Stored::Format("bold".to_owned(), "null".to_owned()));
            items.push(Stored::Letters("y"));
        }
        let note = empty_note();
        note.apply(&sequence_of(&items)).expect("the items apply");
        let (paragraph, bold_runs, plain_runs) = (1, 100, 100);
        let (a_run, its_copy_of_bold) = (1, 1);
        let bold = bold_runs * (a_run + its_copy_of_bold);
        stops_one_node_short_of(&note, paragraph + bold + plain_runs * a_run);
    }

    #[test]
    fn spends_a_node_for_each_block_that_boundaries_make() {
        let note = empty_note();
        let boundaries = vec![Stored::Element(BOUNDARY); 500];
        note.apply(&sequence_of(&boundaries)).expect("they apply");
        stops_one_node_short_of(&note, 500);
    }

    #[test]
    fn spends_nodes_for_no_more_than_64_entries_of_a_path() {
        let ids: Vec<String> = (0..70).map(|depth| format!("q{depth}")).collect();
        let path: Vec<&str> = ids.iter().map(String::as_str).collect();
        let note = note_of(|txn, sequence| {
            insert_boundary(txn, sequence, PARAGRAPH, &path);
        });
        let containers = note.doc.get_or_insert_map(ROOT_CONTAINERS);
        {
            let mut txn = note.doc.transact_mut();
            for id in &ids {
                containers.insert(&mut txn, id.as_str(), Any::from("blockquote"));
            }
        }
        let (entries, quotes, paragraph) = (MAX_PATH_ENTRIES, MAX_PATH_ENTRIES, 1);
        stops_one_node_short_of(&note, entries + quotes + paragraph);
    }

    #[test]
    fn spends_a_node_for_each_paragraph_it_adds_however_many() {
        let after_rules = note_of(|txn, sequence| {
            for rule in 0..50 {
                insert_boundary(txn, sequence, "horizontalRule", &[]);
                sequence.insert(txn, 2 * rule + 1, "x");
            }
        });
        let (rule, paragraph_after, run) = (1, 1, 1);
        stops_one_node_short_of(&after_rules, 50 * (rule + paragraph_after + run));

        let items: Vec<String> = (0..50).map(|item| format!("i{item}")).collect();
        let first_in_items = note_of(|txn, sequence| {
            for item in &items {
                insert_boundary(txn, sequence, "heading", &["L", item.as_str()]);
            }
        });
        let containers = first_in_items.doc.get_or_insert_map(ROOT_CONTAINERS);
        {
            let mut txn = first_in_items.doc.transact_mut();
            containers.insert(&mut txn, "L", Any::from("bulletList"));
            for item in &items {
                containers.insert(&mut txn, item.as_str(), Any::from("listItem"));
            }
        }
        let (list, entries, item, first_paragraph, heading) = (1, 2, 1, 1, 1);
        let each = entries + item + first_paragraph + heading;
        stops_one_node_short_of(&first_in_items, list + 50 * each);
    }

    #[test]
    fn charges_a_mark_again_for_every_text_run_that_holds_a_copy_of_it() {
        let href = "h".repeat(1_000);
        let cut_into = |runs: usize| {
            let mut letters = Vec::new();
            for run in 0..runs {
                if run > 0 {
                    letters.push(Stored::Element("hardBreak"));
                }
                letters.push(Stored::Letters("x"));
            }
            linked(&href, &letters)
        };
        let (one_run, many_runs) = (cut_into(1), cut_into(21));
        let (_, bytes) = spent(&many_runs);
        assert!(bytes - spent(&one_run).1 >= 20 * href.len());
        stops_one_byte_short_of(&many_runs, bytes);
    }

    #[test]
    fn joins_letters_under_unchanged_formatting_without_comparing_their_marks() {
        let href = "h".repeat(1_000);
        let mut letters = Vec::new();
        for _ in 0..1_001 {
            letters.push(Stored::Letters("x"));
            letters.push(Stored::Element("nonsense"));
        }
        let note = linked(&href, &letters);
        assert_eq!(mark_values_compared(&note), 0);

        let read = document(&note).expect("the note reads");
        let runs = read["content"][0]["content"].as_array().expect("its runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["text"], "x".repeat(1_001));
        assert_eq!(runs[0]["marks"][0]["attrs"]["href"], href);

        let (paragraph, run, link, its_href) = (1, 1, 1, 1);
        stops_one_node_short_of(&note, paragraph + run + link + its_href);
        let (letters, read_once, copied_once) = (1_001, href.len(), href.len());
        stops_one_byte_short_of(&note, letters + read_once + copied_once);
    }

    #[test]
    fn charges_the_marks_each_time_it_reads_and_compares_them_after_a_formatting_item() {
        let href = "h".repeat(1_000);
        let mut letters = Vec::new();
        for _ in 0..10 {
            letters.push(Stored::Format("italic".to_owned(), "{}".to_owned()));
            letters.push(Stored::Format("italic".to_owned(), "null".to_owned()));
            letters.push(Stored::Letters("x"));
        }
        let note = linked(&href, &letters);
        assert_eq!(mark_values_compared(&note), 9);

        let read = document(&note).expect("the note reads");
        let runs = read["content"][0]["content"].as_array().expect("its runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["text"], "x".repeat(10));

        let (paragraph, run, link, its_href) = (1, 1, 1, 1);
        stops_one_node_short_of(&note, paragraph + run + link + its_href);
        let (letters, reads, copies, compares) = (10, 10, 1, 9);
        stops_one_byte_short_of(&note, letters + (reads + copies + compares) * href.len());
    }

    #[test]
    fn charges_a_container_attribute_each_time_the_container_opens_kept_or_repaired() {
        let a_line = "x".repeat(1_000);
        let two_lines = format!("{a_line}\u{2028}");
        for title in [a_line.as_str(), two_lines.as_str()] {
            let note = note_of(|txn, sequence| {
                for _ in 0..20 {
                    insert_boundary(txn, sequence, PARAGRAPH, &["c"]);
                    insert_boundary(txn, sequence, PARAGRAPH, &[]);
                }
            });
            let containers = note.doc.get_or_insert_map(ROOT_CONTAINERS);
            {
                let mut txn = note.doc.transact_mut();
                containers.insert(&mut txn, "c", Any::from("callout"));
                containers.insert(&mut txn, "c.title", Any::from(title));
            }
            let read = document(&note).expect("the note reads");
            let kept = if title == a_line { title } else { "" };
            assert_eq!(read["content"][38]["attrs"]["title"], kept);

            let (entry, callout, its_title, paragraph) = (1, 1, 1, 1);
            let inside = entry + callout + its_title + paragraph;
            stops_one_node_short_of(&note, 20 * (inside + paragraph));
            let inside = "c".len() + "callout".len() + title.len() + PARAGRAPH.len();
            stops_one_byte_short_of(&note, 20 * (inside + PARAGRAPH.len()));
        }
    }

    #[test]
    fn charges_the_bytes_of_an_attribute_it_repairs() {
        let note = note_of(|txn, sequence| {
            let code = sequence.insert_embed(txn, 0, XmlElementPrelim::empty(BOUNDARY));
            code.insert_attribute(txn, "type", Any::from("codeBlock"));
            code.insert_attribute(txn, "language", Any::from("two\nlines"));
        });
        let read = document(&note).expect("the note reads");
        assert_eq!(read["content"][0]["attrs"], json!({ "language": null }));

        let (code_block, its_language) = (1, 1);
        stops_one_node_short_of(&note, code_block + its_language);
        stops_one_byte_short_of(&note, "codeBlock".len() + "two\nlines".len());
    }

    #[test]
    fn reads_body_when_a_copy_marked_2_holds_its_text_only_there() {
        let copy = empty_note();
        copy.richdoc_append_paragraph("Written before the marker");
        assert!(copy.body_sequence_roots().is_some());
        assert_eq!(live_items(&copy), 0);
        let written = copy.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "Written before the marker\n");
        assert!(admitted(&copy).is_err());
    }

    #[test]
    fn reads_the_sequence_when_it_holds_an_item_whatever_body_holds() {
        let note = &notes()[0];
        let markdown = note.markdown.as_deref().expect("it is recorded");
        let doc = stored(note);
        doc.richdoc_append_paragraph("stray");
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, markdown);
        assert!(admitted(&doc).is_err());
    }

    #[test]
    fn is_no_sequence_note_when_its_version_is_not_stored_as_a_plain_value() {
        const KEYED_EMBED: u8 = 0x20 | 5;
        let mut version = vec![1, 1, 9, 0, KEYED_EMBED, 1];
        var_string(&mut version, ROOT_META);
        var_string(&mut version, "schemaVersion");
        var_string(&mut version, "2.0");
        version.push(0);

        let doc = Ydoc::wire().reading_body_sequence();
        doc.apply(&version).expect("the version applies");
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        sequence.insert(&mut doc.doc.transact_mut(), 0, "letters");
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        let shown = meta.get(&doc.doc.transact(), "schemaVersion");
        assert_eq!(shown, Some(Out::Any(Any::Number(2.0))));
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "");
        assert!(admitted(&doc).is_err());
    }

    #[test]
    fn the_engines_own_writer_embeds_nothing_in_a_paragraphs_text() {
        let mut letters_and_formatting = 0;
        for note in notes() {
            let Some(markdown) = note.markdown else {
                continue;
            };
            for reading in [MarkdownReading::Projection, MarkdownReading::Source] {
                let doc = Ydoc::wire();
                let kind = ContentKind::Richdoc;
                let written = doc.rewrite_content_to_markdown_as(kind, &markdown, reading);
                if written.is_err() {
                    continue;
                }
                let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
                let txn = doc.doc.transact();
                let (mut held, mut other) = (0, 0);
                for block in body.children(&txn) {
                    items_in_texts(&txn, block, &mut held, &mut other);
                }
                assert_eq!(other, 0, "{}", note.name);
                letters_and_formatting += held;
            }
        }
        assert!(letters_and_formatting >= 20, "{letters_and_formatting}");
    }

    #[test]
    fn reads_a_note_two_people_edited_at_length_within_the_nodes_counted_for_it() {
        const NODES_SPENT: usize = 1_116;
        let edited: EditedNote = serde_json::from_str(EDITED_NOTE).expect("the note parses");
        let doc = opened(&edited.update);
        let read = document(&doc).expect("the note reads");
        let (recorded, here) = (top_blocks(&edited.document), top_blocks(&read));
        let blocks = differing(&recorded, &here, same_document);
        assert!(same_document(&edited.document, &read), "{blocks}");

        let live = live_items(&doc);
        let (counted, at_most) = (edited.stored.live, edited.stored.nodes_at_most);
        assert!((1_000..=counted).contains(&live), "{live} live items");
        assert!(NODES_SPENT < live && NODES_SPENT <= at_most);
        stops_one_node_short_of(&doc, NODES_SPENT);
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
