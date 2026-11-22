//! Reads a note body stored as one sequence (format 2) into the tree the
//! Markdown writer takes. The rules are sections 2 and 3 of
//! `docs/engineering/note-body-sequence.md`, and
//! `packages/ydoc-projection/src/fixtures/body-sequence.json` pins this reader
//! to the TypeScript one.

use super::*;
use yrs::types::Attrs;

const TOP: &str = "doc";
const BOUNDARY: &str = "block";
const PARAGRAPH: &str = "paragraph";
const MAX_PATH_ENTRIES: usize = 64;
const MAX_ID_BYTES: usize = 32;
const MAX_COLUMN_WIDTHS: usize = 1000;
const SAFE_INTEGER: u64 = (1 << 53) - 1;

type Attributes = BTreeMap<String, Value>;
type Held = ProjectionResult<Option<Value>>;
type Path = Vec<(String, &'static str)>;

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
    Bool,
    Whole(f64, f64),
    WholeOrNull(f64, f64),
    Fold,
    Side,
    Widths,
}

impl Holds {
    fn null(self) -> bool {
        matches!(
            self,
            Holds::TextOrNull | Holds::WholeOrNull(..) | Holds::Side | Holds::Widths
        )
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
const CODE_BLOCK: &[Attribute] = &[text_or_null("language")];
const TEX: &[Attribute] = &[text("tex")];
const SOURCE: &[Attribute] = &[text("source")];
const IMAGE: &[Attribute] = &[text("src"), text("alt"), text_or_null("title")];
const WIKILINK: &[Attribute] = &[text("target"), text_or_null("label")];
const ESCAPED_PUNCTUATION: &[Attribute] = &[text("value")];
const INLINE_ATOM: &[Attribute] = &[text("atomId"), text("params"), text("source")];
const CALLOUT: &[Attribute] = &[
    attribute("calloutType", Holds::Text, Missing::Text("note")),
    text("title"),
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
    if width.fract() == 0.0 && width <= SAFE_INTEGER as f64 {
        Some(json!(width as i64))
    } else {
        Some(json!(width))
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

fn push_letters(place: &mut Vec<MarkdownNode>, text: &str, marks: Vec<MarkdownMark>) {
    if !matches!(place.last(), Some(MarkdownNode::Text(_))) {
        place.push(MarkdownNode::Text(Vec::new()));
    }
    let Some(MarkdownNode::Text(runs)) = place.last_mut() else {
        return;
    };
    match runs.last_mut() {
        Some(run) if run.marks == marks => run.text.push_str(text),
        _ => runs.push(TextRun {
            text: text.to_owned(),
            marks,
        }),
    }
}

fn continue_letters(place: &mut [MarkdownNode], text: &str) -> bool {
    let Some(MarkdownNode::Text(runs)) = place.last_mut() else {
        return false;
    };
    let Some(run) = runs.last_mut() else {
        return false;
    };
    run.text.push_str(text);
    true
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

    fn marks(&mut self, stored: &Attrs, depth: usize) -> ProjectionResult<Vec<MarkdownMark>> {
        if let Some(Any::Map(stored)) = stored.get("code") {
            return Ok(vec![self.mark(MarkKind::Code, "code", stored, depth)?]);
        }
        let mut marks = Vec::new();
        for (kind, name) in MARKS {
            if let Some(Any::Map(stored)) = stored.get(name) {
                marks.push(self.mark(kind, name, stored, depth)?);
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

    fn before_any_boundary() -> Self {
        Leaf::new(PARAGRAPH, Attributes::new())
    }

    fn holds_letters(&self) -> bool {
        self.after.is_empty() && matches!(self.tag, PARAGRAPH | "heading" | "codeBlock")
    }

    fn holds_inline_items(&self) -> bool {
        self.after.is_empty() && matches!(self.tag, PARAGRAPH | "heading")
    }
}

struct Reader<'a, T> {
    txn: &'a T,
    containers: &'a MapRef,
    budget: Budget<'a>,
    top: Vec<MarkdownNode>,
    open: Vec<Open>,
    leaf: Option<Leaf>,
}

impl<T: ReadTxn> Reader<'_, T> {
    fn letters(&mut self, text: &str, stored: &Attrs, continues: bool) -> ProjectionResult<()> {
        let depth = self.open.len() + 1;
        self.budget.bytes(text.len())?;
        let leaf = self.leaf.get_or_insert_with(Leaf::before_any_boundary);
        let (place, marked) = if leaf.holds_letters() {
            (&mut leaf.held, leaf.tag != "codeBlock")
        } else {
            (&mut leaf.after, true)
        };
        if continues && continue_letters(place, text) {
            return Ok(());
        }
        self.budget.node(depth)?;
        let marks = if marked {
            self.budget.marks(stored, depth)?
        } else {
            Vec::new()
        };
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
        self.budget.node(depth)?;
        self.budget.bytes(tag.len())?;
        let held = |name: &str| plain(stored.get_attribute(txn, name));
        let attrs = self.budget.attributes(tag, depth, held)?;
        let leaf = self.leaf.get_or_insert_with(Leaf::before_any_boundary);
        let place = if leaf.holds_inline_items() {
            &mut leaf.held
        } else {
            &mut leaf.after
        };
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
        self.close_to(shared);
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

    fn close_to(&mut self, depth: usize) {
        while self.open.len() > depth {
            let Some(mut closed) = self.open.pop() else {
                return;
            };
            let item = matches!(closed.tag, "listItem" | "taskItem");
            if item && !starts_with_paragraph(&closed.content) {
                let paragraph = element(PARAGRAPH, Attributes::new(), Vec::new());
                closed.content.insert(0, paragraph);
            }
            let node = element(closed.tag, closed.attrs, closed.content);
            self.place().push(node);
        }
    }

    fn finish(mut self) -> Vec<MarkdownNode> {
        self.close_leaf();
        self.close_to(0);
        if self.top.is_empty() {
            self.top.push(element(PARAGRAPH, Attributes::new(), Vec::new()));
        }
        self.top
    }
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
        top: Vec::new(),
        open: Vec::new(),
        leaf: None,
    };
    sequence.try_visit_diff(txn, |chunk| match chunk {
        TextDiffChunk::Text {
            text,
            attributes,
            continues_previous,
        } => reader.letters(text, attributes, continues_previous),
        TextDiffChunk::Embed {
            insert: Out::YXmlElement(stored),
            ..
        } => reader.element(&stored),
        TextDiffChunk::Embed { .. } => Ok(()),
    })?;
    Ok(reader.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const NOTES: &str =
        include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence.json");

    #[derive(serde::Deserialize)]
    struct Note {
        name: String,
        update: String,
        document: Value,
        markdown: String,
    }

    fn notes() -> Vec<Note> {
        serde_json::from_str(NOTES).expect("the shared notes parse")
    }

    fn stored(note: &Note) -> Ydoc {
        let doc = Ydoc::wire().reading_body_sequence();
        let update = base64::engine::general_purpose::STANDARD
            .decode(&note.update)
            .expect("the note's update is base64");
        doc.apply(&update).expect("the note's update applies");
        doc
    }

    fn document(doc: &Ydoc) -> ProjectionResult<Value> {
        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
        let txn = doc.doc.transact();
        let mut nodes = MAX_PROJECTION_NODES;
        let mut bytes = 0;
        let read = blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes)?;
        Ok(json!({ "type": TOP, "content": shown(&read) }))
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

    fn top_blocks(document: &Value) -> Vec<String> {
        let blocks = document["content"].as_array();
        blocks.into_iter().flatten().map(Value::to_string).collect()
    }

    fn lines(markdown: &str) -> Vec<String> {
        markdown.split('\n').map(str::to_owned).collect()
    }

    fn differing(recorded: &[String], here: &[String]) -> String {
        let mut differing = Vec::new();
        for at in 0..recorded.len().max(here.len()) {
            if recorded.get(at) != here.get(at) {
                differing.push(format!(
                    "  {at} recorded: {:?}\n  {at} here:     {:?}",
                    recorded.get(at),
                    here.get(at)
                ));
            }
        }
        differing.join("\n")
    }

    #[test]
    fn reads_every_shared_note_as_its_document_and_writes_its_markdown_byte_for_byte() {
        let notes = notes();
        assert!(notes.len() >= 20, "the shared notes are all there");
        let mut differences = Vec::new();
        for note in &notes {
            let doc = stored(note);
            match document(&doc) {
                Ok(read) if read == note.document => {}
                Ok(read) => differences.push(format!(
                    "{}: these blocks of the document differ\n{}",
                    note.name,
                    differing(&top_blocks(&note.document), &top_blocks(&read))
                )),
                Err(error) => differences.push(format!("{}: {error}", note.name)),
            }
            match doc.project(ContentKind::Richdoc) {
                Ok(written) if written.content == note.markdown => {}
                Ok(written) => differences.push(format!(
                    "{}: these lines of the Markdown differ\n{}",
                    note.name,
                    differing(&lines(&note.markdown), &lines(&written.content))
                )),
                Err(error) => differences.push(format!("{}: {error}", note.name)),
            }
        }
        assert!(differences.is_empty(), "{}", differences.join("\n\n"));
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
    fn refuses_a_sequence_note_that_holds_blocks_under_body() {
        let doc = stored(&notes()[0]);
        doc.richdoc_append_paragraph("under body");
        assert!(matches!(
            doc.validate_public_baseline(&doc.encode_full_state()),
            Err(CollabError::MalformedUpdate { .. })
        ));
    }

    #[test]
    fn refuses_sequence_roots_on_a_note_whose_body_is_under_body() {
        let doc = Ydoc::wire().reading_body_sequence();
        doc.richdoc_append_paragraph("under body");
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        meta.insert(&mut doc.doc.transact_mut(), "schemaVersion", Any::Number(1.0));
        doc.validate_public_baseline(&doc.encode_full_state())
            .expect("a note whose body is under body is admitted as before");
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        assert_eq!(written.content, "under body\n");

        let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
        sequence.insert(&mut doc.doc.transact_mut(), 0, "letters");
        let refused = doc.validate_public_baseline(&doc.encode_full_state());
        assert!(refused.is_err());
    }

    #[test]
    fn writes_frontmatter_above_a_sequence_body() {
        let note = &notes()[0];
        let doc = stored(note);
        let frontmatter = doc.doc.get_or_insert_map(ROOT_FRONTMATTER);
        frontmatter.insert(&mut doc.doc.transact_mut(), "title", "Plan");
        let written = doc.project(ContentKind::Richdoc).expect("it writes");
        let expected = format!("---\ntitle: Plan\n---\n\n{}", note.markdown);
        assert_eq!(written.content, expected);
    }

    #[test]
    fn stops_at_the_node_budget() {
        let doc = stored(&notes()[0]);
        assert!(matches!(
            doc.project_richdoc_with_node_budget(8),
            Err(CollabError::ProjectionTooComplex { .. })
        ));
        let within = doc.project_richdoc_with_node_budget(MAX_PROJECTION_NODES);
        assert!(within.is_ok());
    }
}
