//! The engine's Markdown reader. It reads a note's body as the editor's
//! reader does and builds the elements the editor writes into the Y.Doc.
//!
//! pulldown-cmark parses the CommonMark and GFM syntax. This file maps its
//! events to elements and adds what the editor reads on top of it: dohc's
//! own syntax (highlight, underline, wikilinks, atoms, callouts, math
//! blocks), links from bare URLs, raw HTML and link definitions kept as
//! text, and the editor's list and whitespace rules.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{
    Alignment, BrokenLink, CodeBlockKind, CowStr, Event, LinkType, Options, Parser, Tag, TagEnd,
};
use yrs::types::{Attrs, Delta};
use yrs::{Any, Text, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

/// The deepest a text sits in what the reader builds, from the body's
/// blocks at 0. The projector reads a link's fields three levels below its
/// text and refuses past 128, so whatever the reader builds can be written.
pub(super) const MAX_DEPTH: usize = 125;

/// The most quotes the reader nests, as the editor's reader allows.
pub(super) const MAX_QUOTES: usize = 120;

/// One element the editor writes, with its attributes and children.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Element {
    pub(super) tag: &'static str,
    pub(super) attrs: Vec<(&'static str, Any)>,
    pub(super) children: Vec<Child>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Child {
    Element(Element),
    /// One text node: runs of text with their marks.
    Text(Vec<(String, Marks)>),
}

/// A field added here that `attrs` writes must also be compared in
/// `writes_as`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Marks {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    underline: bool,
    highlight: bool,
    /// A link's href and title.
    link: Option<(String, Option<String>)>,
    /// Text the editor keeps as written that a renderer reads as markup: raw
    /// HTML, a comment, or a reference it decodes. Not written to the Y.Doc;
    /// it tells two readings apart where a renderer would.
    raw: bool,
}

/// Whether a renderer reads markup in `text` that the editor keeps as text.
fn renders_markup(text: &str) -> bool {
    text.match_indices('<')
        .any(|(at, _)| super::inline_syntax(&text[at..]).is_some())
        || text.match_indices('&').any(|(at, _)| {
            let rest = &text.as_bytes()[at + 1..];
            // No reference name is longer than 32 bytes.
            rest.iter()
                .take(33)
                .position(|&byte| byte == b';')
                .is_some_and(|end| {
                    let name = &rest[..end];
                    name.iter().any(u8::is_ascii_alphanumeric)
                        && name
                            .iter()
                            .all(|&byte| byte.is_ascii_alphanumeric() || byte == b'#')
                        && super::rendered_reference(&text[at + 1..at + 1 + end])
                })
        })
}

impl Marks {
    /// Whether both write the same attributes, which `raw` is not one of.
    fn writes_as(&self, other: &Marks) -> bool {
        self.bold == other.bold
            && self.italic == other.italic
            && self.strike == other.strike
            && self.code == other.code
            && self.underline == other.underline
            && self.highlight == other.highlight
            && self.link == other.link
    }

    fn attrs(&self) -> Option<Attrs> {
        let mut attrs = Attrs::new();
        for (on, name) in [
            (self.bold, "bold"),
            (self.italic, "italic"),
            (self.strike, "strike"),
            (self.code, "code"),
            (self.underline, "underline"),
            (self.highlight, "highlight"),
        ] {
            if on {
                attrs.insert(name.into(), Any::Map(Default::default()));
            }
        }
        if let Some((href, title)) = &self.link {
            let title = title.as_deref().map_or(Any::Null, Any::from);
            let link = HashMap::from([
                ("href".to_owned(), Any::from(href.as_str())),
                ("target".to_owned(), Any::from("_blank")),
                ("rel".to_owned(), Any::from("noopener noreferrer nofollow")),
                ("class".to_owned(), Any::Null),
                ("title".to_owned(), title),
            ]);
            attrs.insert("link".into(), Any::from(link));
        }
        (!attrs.is_empty()).then_some(attrs)
    }
}

/// Why the reader built nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unreadable {
    /// Elements nest deeper than [`MAX_DEPTH`] outside a quote.
    TooDeep,
    /// Quotes nest deeper than [`MAX_QUOTES`], or elements deeper than
    /// [`MAX_DEPTH`] inside one.
    QuoteTooDeep,
}

/// The body's blocks as the editor reads them.
pub(super) fn read_markdown(body: &str) -> Result<Vec<Element>, Unreadable> {
    read_blocks(body, 0, 0, &HashMap::new())
}

/// Whether a source shows what its projection shows: the same elements, with
/// an escaped character read as the character it shows. Only the source's
/// markup counts, since the source is what would be written; markup the
/// projection writes, such as a cell's `<br>`, is not written.
pub(super) fn shows_alike(source: &[Element], projection: &[Element]) -> bool {
    fn shown(children: &[Child], raw_counts: bool) -> Vec<Child> {
        let mut out: Vec<Child> = Vec::new();
        for child in children {
            let runs = match child {
                Child::Element(element) if element.tag == "escapedPunctuation" => {
                    let value = element.attrs.iter().find_map(|(name, value)| match value {
                        Any::String(text) if *name == "value" => Some(text.to_string()),
                        _ => None,
                    });
                    vec![(value.unwrap_or_default(), Marks::default())]
                }
                Child::Element(element) => {
                    out.push(Child::Element(Element {
                        tag: element.tag,
                        attrs: element.attrs.clone(),
                        children: shown(&element.children, raw_counts),
                    }));
                    continue;
                }
                Child::Text(runs) => runs.clone(),
            };
            if !matches!(out.last(), Some(Child::Text(_))) {
                out.push(Child::Text(Vec::new()));
            }
            let Some(Child::Text(last)) = out.last_mut() else {
                unreachable!("a text child was just pushed");
            };
            for (text, mut marks) in runs {
                marks.raw &= raw_counts;
                match last.last_mut() {
                    Some((before, before_marks)) if *before_marks == marks => {
                        before.push_str(&text)
                    }
                    _ => last.push((text, marks)),
                }
            }
        }
        out
    }
    let shown = |elements: &[Element], raw_counts| {
        shown(
            &elements
                .iter()
                .cloned()
                .map(Child::Element)
                .collect::<Vec<_>>(),
            raw_counts,
        )
    };
    shown(source, true) == shown(projection, false)
}

/// Insert `element` at `index` of `parent`.
pub(super) fn insert_element<F: XmlFragment>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    element: &Element,
) {
    let el = parent.insert(txn, index, XmlElementPrelim::empty(element.tag));
    for (key, value) in &element.attrs {
        el.insert_attribute(txn, *key, value.clone());
    }
    // Inserting at the front walks no items, so children go in last first.
    for child in element.children.iter().rev() {
        match child {
            Child::Element(child) => insert_element(txn, &el, 0, child),
            Child::Text(runs) => {
                // Runs whose written marks match join, since each delta
                // takes time that grows with the text before it.
                let mut deltas: Vec<(std::borrow::Cow<'_, str>, &Marks)> = Vec::new();
                for (run, marks) in runs {
                    match deltas.last_mut() {
                        Some((text, last)) if last.writes_as(marks) => text.to_mut().push_str(run),
                        _ => deltas.push((run.as_str().into(), marks)),
                    }
                }
                if let [(run, marks)] = deltas.as_slice() {
                    if marks.writes_as(&Marks::default()) {
                        el.insert(txn, 0, XmlTextPrelim::new(run.as_ref()));
                        continue;
                    }
                }
                let text = el.insert(txn, 0, XmlTextPrelim::new(""));
                text.apply_delta(
                    txn,
                    deltas.iter().map(|(run, marks)| {
                        Delta::Inserted(run.as_ref(), marks.attrs().map(Box::new))
                    }),
                );
            }
        }
    }
}

type Definitions = HashMap<String, (String, String)>;

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
}

/// marked and pulldown-cmark match a reference label case-insensitively with
/// its whitespace collapsed.
fn label_key(label: &str) -> String {
    label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn read_blocks(
    src: &str,
    depth: usize,
    quotes: usize,
    outer: &Definitions,
) -> Result<Vec<Element>, Unreadable> {
    let mut resolve = |link: BrokenLink<'_>| {
        outer
            .get(&label_key(&link.reference))
            .map(|(href, title)| (CowStr::from(href.clone()), CowStr::from(title.clone())))
    };
    let parser = Parser::new_with_broken_link_callback(src, options(), Some(&mut resolve));
    let mut definitions = outer.clone();
    let mut spans = Vec::new();
    for (label, definition) in parser.reference_definitions().iter() {
        spans.push(definition.span.clone());
        definitions.entry(label_key(label)).or_insert_with(|| {
            let raw = &src[definition.span.clone()];
            raw.contains('&')
                .then(|| raw.find("]:").and_then(|at| link_target(&raw[at + 2..])))
                .flatten()
                .unwrap_or_else(|| {
                    (
                        definition.dest.to_string(),
                        definition.title.as_deref().unwrap_or("").to_owned(),
                    )
                })
        });
    }
    spans.sort_by_key(|span| span.start);
    let mut reader = Reader {
        src,
        depth,
        quotes,
        definitions,
        spans,
        next_span: 0,
        frames: vec![Frame::new(Kind::Body, 0)],
        callouts: Vec::new(),
        marks: Marks::default(),
        saved: Vec::new(),
        links: Vec::new(),
        image: None,
        annotation: None,
    };
    for (event, range) in parser.into_offset_iter() {
        reader.event(event, range)?;
    }
    reader.close_implicit();
    reader.flush_definitions(src.len());
    let mut body = reader.frames.pop().expect("the body frame");
    // Every pair of line breaks that ends the note is an empty paragraph.
    let trailing = reader.separators(body.last_end.unwrap_or(0), src.len(), true);
    body.blocks
        .extend((0..trailing).map(|_| paragraph(Vec::new())));
    Ok(body.blocks)
}

#[derive(Debug)]
enum Kind {
    Body,
    Quote,
    List(Option<u64>),
    Item {
        task: Option<bool>,
        indent: usize,
        blank_first: bool,
    },
    Paragraph {
        implicit: bool,
    },
    Heading(i64),
    Cell,
    CodeBlock(String),
    Html,
    Table(Vec<Alignment>, Vec<(usize, i64)>),
    Row,
}

impl Kind {
    fn holds_text(&self) -> bool {
        matches!(self, Kind::Paragraph { .. } | Kind::Heading(_) | Kind::Cell)
    }
}

struct Frame {
    kind: Kind,
    blocks: Vec<Element>,
    pieces: Vec<Piece>,
    text: String,
    /// Open HTML tags in this text block: name, piece count, source start,
    /// and the marks they opened under.
    tags: Vec<(String, usize, usize, Marks)>,
    /// The pieces that are a `&lt;` or `&gt;`, which bound the tag span.
    brackets: Vec<usize>,
    /// The end of the last piece's source, to tell an escape's backslash
    /// from one that is text.
    covered: usize,
    /// Where the content of this container's last block ends, to count the
    /// blank lines after it.
    last_end: Option<usize>,
    /// The piece count when the first inline syntax came, and its start.
    content: Option<(usize, usize)>,
    /// Whether this text block holds syntax the reader can't map for sure,
    /// so it is kept as its source.
    sealed: bool,
}

impl Frame {
    fn new(kind: Kind, start: usize) -> Self {
        Frame {
            kind,
            blocks: Vec::new(),
            pieces: Vec::new(),
            text: String::new(),
            tags: Vec::new(),
            brackets: Vec::new(),
            covered: start,
            last_end: None,
            content: None,
            sealed: false,
        }
    }
}

#[derive(Debug, Clone)]
enum Piece {
    /// Text with its marks. `at` is its source offset when the text is the
    /// source as written, which the syntax pulldown-cmark doesn't know needs.
    Text {
        text: String,
        marks: Marks,
        at: Option<usize>,
    },
    Node(Element),
    /// An escaped character, with the marks around it: a highlight reads
    /// `\=` as `=` in them.
    Escaped {
        value: String,
        marks: Marks,
    },
    /// A `$$` math span, which stands alone on its lines to be a block.
    DisplayMath {
        tex: String,
        source: Range<usize>,
    },
}

struct Image {
    src: String,
    title: String,
    alt: String,
    open: usize,
}

struct Reader<'a> {
    src: &'a str,
    /// The depth and quotes of the block this body is read in.
    depth: usize,
    quotes: usize,
    definitions: Definitions,
    spans: Vec<Range<usize>>,
    next_span: usize,
    frames: Vec<Frame>,
    /// Whether each open quote is a callout.
    callouts: Vec<bool>,
    marks: Marks,
    saved: Vec<Marks>,
    /// Each open link's piece count and source.
    links: Vec<(usize, Range<usize>)>,
    image: Option<Image>,
    annotation: Option<Annotation>,
}

/// A row-height annotation just read: its frame depth, block index,
/// heights, and source end.
type Annotation = (usize, usize, Vec<(usize, i64)>, usize);

fn element(tag: &'static str, attrs: Vec<(&'static str, Any)>, children: Vec<Child>) -> Element {
    Element {
        tag,
        attrs,
        children,
    }
}

fn paragraph(children: Vec<Child>) -> Element {
    element("paragraph", Vec::new(), children)
}

fn text_paragraph(text: String) -> Element {
    if text.is_empty() {
        paragraph(Vec::new())
    } else {
        paragraph(vec![Child::Text(vec![(text, Marks::default())])])
    }
}

impl<'a> Reader<'a> {
    fn top(&mut self) -> &mut Frame {
        self.frames.last_mut().expect("the body frame")
    }

    /// The quotes around the innermost frame, callouts' included.
    fn quotes(&self) -> usize {
        self.quotes
            + self
                .frames
                .iter()
                .filter(|frame| matches!(frame.kind, Kind::Quote))
                .count()
    }

    fn push_frame(&mut self, kind: Kind, start: usize) -> Result<(), Unreadable> {
        let quotes = self.quotes() + usize::from(matches!(kind, Kind::Quote));
        // The new frame's element sits `frames.len() - 1` below the body's
        // depth, and what it holds one further.
        if self.depth + self.frames.len() > MAX_DEPTH || quotes > MAX_QUOTES {
            return Err(if quotes > 0 {
                Unreadable::QuoteTooDeep
            } else {
                Unreadable::TooDeep
            });
        }
        self.frames.push(Frame::new(kind, start));
        Ok(())
    }

    /// The innermost frame that holds blocks.
    fn container(&mut self) -> &mut Frame {
        let at = self
            .frames
            .iter()
            .rposition(|frame| !frame.kind.holds_text())
            .expect("the body frame");
        &mut self.frames[at]
    }

    fn push_block(&mut self, block: Element) {
        self.container().blocks.push(block);
    }

    /// Record that the container's last block ends at `end`, after its
    /// trailing white space.
    fn block_ends(&mut self, end: usize) {
        let end = self.src[..end.min(self.src.len())].trim_end().len();
        self.container().last_end = Some(end);
    }

    /// How many pairs of line breaks the editor's reader sees between `from`
    /// and `to`, with this container's line prefixes gone. Without
    /// `include_first`, the first line break doesn't count.
    ///
    /// marked gives a block the line breaks right after it. Blank lines that
    /// hold spaces start a token of their own, and then only that token's
    /// line breaks count.
    fn separators(&self, from: usize, to: usize, include_first: bool) -> usize {
        let from = from.min(to);
        let mut lines = self.src[from..to].split('\n');
        let at_line_start = from == 0 || self.src.as_bytes()[from - 1] == b'\n';
        // The lines joined with their prefixes gone: each run of line breaks
        // between two lines with content holds half its length in pairs.
        let mut pairs = 0;
        let mut run = 0;
        if at_line_start {
            lines.next();
            for line in lines {
                run += 1;
                if !self.strip_containers(line).is_empty() {
                    pairs += run / 2;
                    run = 0;
                }
            }
            return pairs + run / 2;
        }
        // The first line is the block's own. The line breaks before the
        // next content go with it, unless no content follows.
        lines.next();
        let mut skip = !include_first;
        let mut leading = true;
        for line in lines {
            if skip {
                skip = false;
            } else {
                run += 1;
            }
            if !self.strip_containers(line).is_empty() {
                if !leading {
                    pairs += run / 2;
                }
                leading = false;
                run = 0;
            }
        }
        pairs + run / 2
    }

    /// The tiptap reader the editor uses keeps a blank line beyond a block
    /// break as an empty paragraph: one for each further pair of line
    /// breaks, and every pair at the start of the note.
    fn blank_paragraphs(&mut self, at: usize) {
        let line = self.line_start(at);
        let container = self
            .frames
            .iter()
            .rposition(|frame| !frame.kind.holds_text())
            .expect("the body frame");
        let frame = &self.frames[container];
        let count = match (frame.last_end, &frame.kind) {
            (Some(end), _) => self.separators(end, line, true).saturating_sub(1),
            (None, Kind::Body) => self.separators(0, line, true),
            _ => 0,
        };
        for _ in 0..count {
            self.frames[container].blocks.push(paragraph(Vec::new()));
        }
    }

    /// Keep each link definition that starts before `upto` as a paragraph
    /// of its source, as the editor does.
    fn flush_definitions(&mut self, upto: usize) {
        while let Some(span) = self.spans.get(self.next_span).cloned() {
            if span.start >= upto {
                break;
            }
            self.next_span += 1;
            let quoted = self
                .frames
                .iter()
                .any(|frame| matches!(frame.kind, Kind::Quote));
            let text = self.src[span.clone()]
                .trim_end()
                .split('\n')
                .map(|line| {
                    if quoted {
                        line.trim_start_matches([' ', '\t', '>'])
                    } else {
                        line.trim_start()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            self.blank_paragraphs(span.start);
            // A renderer hides a definition, which the document holds as text.
            let mut block = text_paragraph(text);
            if let Some(Child::Text(runs)) = block.children.first_mut() {
                runs[0].1.raw = true;
            }
            self.push_block(block);
            self.block_ends(span.end);
        }
    }

    /// Close a tight item's paragraph before a block starts in it.
    fn close_implicit(&mut self) {
        if matches!(self.top().kind, Kind::Paragraph { implicit: true }) {
            let frame = self.frames.pop().expect("the paragraph");
            let end = frame.covered;
            for block in self.finish_paragraph(frame) {
                self.push_block(block);
            }
            self.block_ends(end);
        }
    }

    fn start_block(&mut self, kind: Kind, start: usize) -> Result<(), Unreadable> {
        self.close_implicit();
        self.flush_definitions(start);
        self.blank_paragraphs(start);
        self.push_frame(kind, start)
    }

    /// Make sure inline content has a text block to go in. A tight list
    /// item's text has no paragraph of its own.
    fn text_block(&mut self, start: usize) -> Result<(), Unreadable> {
        if !self.top().kind.holds_text() {
            self.push_frame(Kind::Paragraph { implicit: true }, start)?;
        }
        let frame = self.top();
        if frame.content.is_none() {
            frame.content = Some((frame.pieces.len(), start));
        }
        Ok(())
    }

    fn push_piece(&mut self, piece: Piece, source: &Range<usize>) {
        // A node can't keep a mark or a link around it. The writer moves
        // italic, bold and strike into a link's text and keeps a `*` or `~`
        // there as it is, where it can close the mark early and move.
        let unsure = match &piece {
            Piece::Node(node) => holds_no_marks(node) && !self.marks.writes_as(&Marks::default()),
            Piece::Text { text, marks, .. } => {
                marks.link.is_some()
                    && !marks.code
                    && (((marks.italic || marks.bold) && text.contains('*'))
                        || (marks.strike && text.contains('~')))
            }
            _ => false,
        };
        let frame = self.top();
        frame.sealed |= unsure;
        frame.pieces.push(piece);
        frame.covered = source.end;
    }

    fn push_text(&mut self, text: &str, at: Option<usize>, source: &Range<usize>) {
        if text.is_empty() {
            return;
        }
        let marks = self.marks.clone();
        self.push_piece(
            Piece::Text {
                text: text.to_owned(),
                marks,
                at,
            },
            source,
        );
    }

    /// The columns of a line that its containers leave as content, from
    /// `line_start` to `content`: the quote markers and item indentation go,
    /// as the editor's reader strips them.
    fn kept_indent(&self, line_start: usize, content: usize) -> &'a str {
        self.strip_containers(&self.src[line_start..content])
    }

    fn strip_containers(&self, line: &'a str) -> &'a str {
        let mut rest = line;
        for frame in &self.frames {
            match frame.kind {
                Kind::Quote => rest = strip_quote_marker(rest),
                Kind::Item { indent, .. } => {
                    let spaces = rest.bytes().take_while(|byte| *byte == b' ').count();
                    rest = &rest[spaces.min(indent)..];
                }
                _ => {}
            }
        }
        rest
    }

    /// The source in `range`, where each later line drops what its
    /// containers put before it.
    fn unprefixed(&self, range: &Range<usize>) -> String {
        let mut lines = self.src[range.clone()].split('\n');
        let mut text = lines.next().unwrap_or_default().to_owned();
        for line in lines {
            text.push('\n');
            text.push_str(self.strip_containers(line));
        }
        text
    }

    /// A `$$` span where no math block stands, sealed as its source. The
    /// reader reads nothing inside a formula, and its source written as text
    /// would be escaped.
    fn sealed_formula(&self, source: &Range<usize>) -> Piece {
        Piece::Node(element(
            "rawInline",
            vec![("source", Any::from(self.unprefixed(source)))],
            Vec::new(),
        ))
    }

    fn line_start(&self, at: usize) -> usize {
        self.src[..at].rfind('\n').map_or(0, |newline| newline + 1)
    }

    fn event(&mut self, event: Event<'a>, range: Range<usize>) -> Result<(), Unreadable> {
        if self.image.is_some() && matches!(event, Event::DisplayMath(_)) {
            let text = self.unprefixed(&range);
            if let Some(image) = &mut self.image {
                image.alt.push_str(&text);
            }
            return Ok(());
        }
        if let Some(image) = &mut self.image {
            match event {
                Event::Start(Tag::Image { .. }) => image.open += 1,
                Event::End(TagEnd::Image) => {
                    image.open -= 1;
                    if image.open == 0 {
                        let image = self.image.take().expect("an open image");
                        let mut attrs = vec![
                            ("src", Any::from(super::sanitize_image_src(&image.src))),
                            ("alt", Any::from(image.alt)),
                        ];
                        if !image.title.is_empty() {
                            attrs.push(("title", Any::from(image.title)));
                        }
                        self.push_piece(Piece::Node(element("image", attrs, Vec::new())), &range);
                    }
                }
                Event::Text(text) | Event::Code(text) | Event::InlineMath(text) => {
                    image.alt.push_str(&text);
                }
                Event::SoftBreak | Event::HardBreak => image.alt.push('\n'),
                _ => {}
            }
            return Ok(());
        }
        match event {
            Event::Start(tag) => self.start(tag, range)?,
            Event::End(tag) => self.end(tag, range)?,
            Event::Text(text) => {
                if matches!(self.top().kind, Kind::CodeBlock(_) | Kind::Html) {
                    self.top().text.push_str(&text);
                } else {
                    self.text_block(range.start)?;
                    self.text(&text, range);
                }
            }
            Event::Code(text) => {
                self.text_block(range.start)?;
                let mut marks = self.marks.clone();
                marks.code = true;
                self.push_piece(
                    Piece::Text {
                        text: text.into_string(),
                        marks,
                        at: None,
                    },
                    &range,
                );
            }
            Event::InlineMath(tex) => {
                self.text_block(range.start)?;
                if self.inline_math_reads(&range) {
                    let node = element("mathInline", vec![("tex", Any::from(&*tex))], Vec::new());
                    self.push_piece(Piece::Node(node), &range);
                } else {
                    let source = &self.src[range.clone()];
                    self.push_text(source, Some(range.start), &range);
                }
            }
            Event::DisplayMath(_) => {
                self.text_block(range.start)?;
                // A math block can't keep a link or a mark around it, and the
                // writer has no form for a formula that holds them.
                if self.marks != Marks::default() {
                    self.top().sealed = true;
                }
                let text = self.unprefixed(&range);
                self.push_piece(
                    Piece::DisplayMath {
                        tex: text[2..text.len() - 2].to_owned(),
                        source: range.clone(),
                    },
                    &range,
                );
            }
            Event::Html(text) => self.top().text.push_str(&text),
            Event::InlineHtml(_) => {
                self.text_block(range.start)?;
                self.inline_html(range);
            }
            Event::SoftBreak => {
                self.text_block(range.start)?;
                // The editor keeps the spaces around a line break that
                // CommonMark drops: those ending the line, and the
                // indentation the next line keeps past its containers.
                let src = self.src;
                let before = &src[self.top().covered.min(range.start)..range.start];
                let before = if before.bytes().all(|byte| byte == b' ' || byte == b'\t') {
                    before
                } else {
                    ""
                };
                let end = self.content_start(range.end);
                let indent = self.kept_indent(range.end, end);
                let text = format!("{before}\n{indent}");
                let marks = self.marks.clone();
                self.push_piece(
                    Piece::Text {
                        text,
                        marks,
                        at: None,
                    },
                    &(range.start..end),
                );
            }
            Event::HardBreak => {
                self.text_block(range.start)?;
                self.push_piece(
                    Piece::Node(element("hardBreak", Vec::new(), Vec::new())),
                    &range,
                );
                // The editor keeps the next line's indentation.
                let end = self.content_start(range.end);
                let indent = self.kept_indent(range.end, end);
                self.push_text(indent, None, &(range.end..end));
            }
            Event::Rule => {
                self.close_implicit();
                self.flush_definitions(range.start);
                self.blank_paragraphs(range.start);
                self.push_block(element("horizontalRule", Vec::new(), Vec::new()));
                self.block_ends(range.end);
            }
            Event::TaskListMarker(checked) => self.task_marker(checked, range)?,
            Event::FootnoteReference(_) => {}
        }
        Ok(())
    }

    /// Where the line starting at `line` has its first character that is
    /// neither indentation nor a quote marker.
    fn content_start(&self, line: usize) -> usize {
        let bytes = self.src.as_bytes();
        let mut at = line;
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t' | b'>') {
            at += 1;
        }
        at
    }

    fn task_marker(&mut self, checked: bool, range: Range<usize>) -> Result<(), Unreadable> {
        let item = self
            .frames
            .iter()
            .rposition(|frame| matches!(frame.kind, Kind::Item { .. }));
        let ordered = item
            .is_some_and(|at| at > 0 && matches!(self.frames[at - 1].kind, Kind::List(Some(_))));
        if ordered {
            // The editor reads no task in an ordered list: the marker stays
            // text, with the spaces after it.
            self.text_block(range.start)?;
            let end = self.src[range.end..]
                .find(|character: char| character != ' ' && character != '\t')
                .map_or(self.src.len(), |at| range.end + at);
            let end = if self.src[range.end..end].contains('\n') {
                range.end
            } else {
                end
            };
            let source = &self.src[range.start..end];
            self.push_text(source, Some(range.start), &(range.start..end));
        } else if let Some(at) = item {
            if let Kind::Item { task, .. } = &mut self.frames[at].kind {
                *task = Some(checked);
            }
        }
        Ok(())
    }

    fn text(&mut self, text: &str, range: Range<usize>) {
        let src = self.src;
        let source = &src[range.clone()];
        let frame = self.top();
        // A tight item's text block starts at its first text, after the
        // backslash of an escape there.
        let first = frame.pieces.is_empty();
        let covered = frame.covered;
        let escaped = range.start > 0
            && src.as_bytes()[range.start - 1] == b'\\'
            && (covered < range.start || first)
            && source
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_punctuation())
            && text.starts_with(&source[..1]);
        if escaped {
            // The escape's source starts at its backslash.
            if let Some((_, start)) = &mut self.top().content {
                if *start == range.start {
                    *start -= 1;
                }
            }
            let value = &source[..1];
            let in_cell = matches!(self.top().kind, Kind::Cell);
            let piece_range = range.start..range.start + 1;
            // The editor reads an escape in a link's text, and a table
            // cell's escaped bar, as the character.
            if (in_cell && value == "|") || !self.links.is_empty() {
                self.push_text(value, None, &piece_range);
            } else {
                let marks = self.marks.clone();
                self.push_piece(
                    Piece::Escaped {
                        value: value.to_owned(),
                        marks,
                    },
                    &piece_range,
                );
            }
            let rest = &text[1..];
            if rest == &source[1..] {
                self.push_text(rest, Some(range.start + 1), &range);
            } else {
                self.push_text(rest, None, &range);
            }
        } else if text == source {
            self.push_text(text, Some(range.start), &range);
        } else if source.starts_with('&') && source.ends_with(';') {
            let name = &source[1..source.len() - 1];
            // A tab or space reference that starts its block, or that only
            // spaces come before on its line, reads as its character. The
            // writer spells leading white space that way.
            let leading = || {
                // Containers put only spaces, tabs and `>` before a line, so
                // any other byte back to the line's start rules it out first,
                // without reading the whole line for each reference.
                let indented = || {
                    self.src[..range.start]
                        .bytes()
                        .rev()
                        .take_while(|&byte| byte != b'\n')
                        .all(|byte| matches!(byte, b' ' | b'\t' | b'>'))
                };
                self.frames
                    .last()
                    .is_some_and(|frame| frame.pieces.is_empty())
                    || indented()
                        && self
                            .kept_indent(self.line_start(range.start), range.start)
                            .bytes()
                            .all(|byte| byte == b' ')
            };
            let decoded = match name {
                "#9" if leading() => Some("\t"),
                "#32" if leading() => Some(" "),
                _ => decoded_reference(name),
            };
            match decoded {
                Some(decoded) => {
                    if matches!(name, "lt" | "gt") {
                        let frame = self.top();
                        frame.brackets.push(frame.pieces.len());
                    }
                    self.push_text(decoded, None, &range)
                }
                None => {
                    let raw =
                        std::mem::replace(&mut self.marks.raw, super::rendered_reference(name));
                    self.push_text(source, Some(range.start), &range);
                    self.marks.raw = raw;
                }
            }
        } else {
            self.push_text(text, None, &range);
        }
    }

    /// Whether a `$` math span reads as math by the editor's rules.
    fn inline_math_reads(&self, range: &Range<usize>) -> bool {
        let raw = &self.src[range.clone()];
        let Some(tex) = raw
            .strip_prefix('$')
            .and_then(|rest| rest.strip_suffix('$'))
        else {
            return false;
        };
        let before = self.src[..range.start].chars().next_back();
        let after = self.src[range.end..].chars().next();
        !tex.is_empty()
            && !tex.starts_with(|character: char| character.is_whitespace() || character == '$')
            && !tex.ends_with(char::is_whitespace)
            && before != Some('\\')
            && before != Some('$')
            && !after.is_some_and(|character| character.is_ascii_digit())
            && unescaped(tex, '$').is_none()
    }

    /// A raw HTML tag stays text. An opening tag through the tag that closes
    /// it is one run of text, so the Markdown between them stays text too.
    fn inline_html(&mut self, range: Range<usize>) {
        let raw = self.src[range.clone()].trim_end();
        let marks = self.marks.clone();
        if let Some(name) = closing_tag_name(raw) {
            let frame = self.top();
            if let Some(at) = frame
                .tags
                .iter()
                .position(|(open, ..)| open.eq_ignore_ascii_case(name))
            {
                let (_, pieces, start, mut marks) = frame.tags[at].clone();
                // A renderer reads the links, marks and nodes inside the run,
                // which the document holds as its text.
                let plain = Marks {
                    raw: false,
                    ..marks.clone()
                };
                let read_inside = holds_bare_link(&frame.pieces[pieces..])
                    || frame.pieces[pieces..].iter().any(|piece| match piece {
                        Piece::Text { marks: inner, .. } => {
                            inner.raw
                                || Marks {
                                    raw: false,
                                    ..inner.clone()
                                } != plain
                        }
                        _ => true,
                    });
                frame.tags.truncate(at);
                frame.pieces.truncate(pieces);
                frame.brackets.retain(|&index| index < pieces);
                let run = self.unprefixed(&(start..range.end)).trim_end().to_owned();
                marks.raw = read_inside || renders_markup(&run);
                self.push_piece(
                    Piece::Text {
                        text: run,
                        marks,
                        at: None,
                    },
                    &range,
                );
                return;
            }
        } else if let Some(name) = opening_tag_name(raw) {
            let frame = self.top();
            // Each run that closes reads its text again, so a frame holds at
            // most this many open tags and a deeper tag stays text inside the
            // runs around it. Runs nest, so a note is read at most this many
            // times over.
            if !raw.ends_with("/>") && frame.tags.len() < 32 {
                let pieces = frame.pieces.len();
                frame
                    .tags
                    .push((name.to_owned(), pieces, range.start, marks.clone()));
            }
        }
        self.push_piece(
            Piece::Text {
                text: raw.to_owned(),
                marks: Marks {
                    raw: renders_markup(raw),
                    ..marks
                },
                at: None,
            },
            &range,
        );
    }

    fn start(&mut self, tag: Tag<'a>, range: Range<usize>) -> Result<(), Unreadable> {
        match tag {
            Tag::Paragraph => {
                self.start_block(Kind::Paragraph { implicit: false }, range.start)?;
                let lead = self.kept_indent(self.line_start(range.start), range.start);
                if !lead.is_empty() && lead.bytes().all(|byte| byte == b' ' || byte == b'\t') {
                    self.push_text(lead, None, &(range.start..range.start));
                }
            }
            Tag::Heading { level, .. } => {
                self.start_block(Kind::Heading(level as i64), range.start)?
            }
            Tag::BlockQuote(_) => {
                let first = self.src[range.clone()].split('\n').next().unwrap_or("");
                self.callouts
                    .push(callout_header(strip_quote_marker(first)).is_some());
                self.start_block(Kind::Quote, range.start)?
            }
            Tag::CodeBlock(kind) => {
                let language = match kind {
                    // The editor keeps references in the language as written.
                    CodeBlockKind::Fenced(_)
                        if self.src[range.clone()]
                            .lines()
                            .next()
                            .is_some_and(|line| line.contains('&')) =>
                    {
                        let line = self.src[range.clone()].lines().next().unwrap_or("");
                        let line = line.trim_start();
                        let fence = line.as_bytes().first().copied().unwrap_or(b'`');
                        unescape(line.trim_start_matches(fence as char).trim())
                    }
                    CodeBlockKind::Fenced(info) => info.into_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.start_block(Kind::CodeBlock(language), range.start)?;
            }
            Tag::HtmlBlock => self.start_block(Kind::Html, range.start)?,
            Tag::List(start) => self.start_block(Kind::List(start), range.start)?,
            Tag::Item => {
                self.close_implicit();
                self.flush_definitions(range.start);
                // The blank lines between two items are the first one's.
                let list = self.top();
                if let (Some(end), Some(_)) = (list.last_end, list.blocks.last()) {
                    let count = self.separators(end, self.line_start(range.start), false);
                    if let Some(item) = self.top().blocks.last_mut() {
                        item.children
                            .extend((0..count).map(|_| Child::Element(paragraph(Vec::new()))));
                    }
                }
                let (indent, blank_first) = self.item_indent(range.start);
                self.push_frame(
                    Kind::Item {
                        task: None,
                        indent,
                        blank_first,
                    },
                    range.start,
                )?;
            }
            Tag::Table(alignments) => {
                let heights = self.take_annotation(range.start);
                self.start_block(Kind::Table(alignments, heights), range.start)?;
            }
            Tag::TableHead | Tag::TableRow => self.push_frame(Kind::Row, range.start)?,
            Tag::TableCell => self.push_frame(Kind::Cell, range.start)?,
            Tag::Emphasis | Tag::Strong | Tag::Strikethrough => {
                self.text_block(range.start)?;
                self.saved.push(self.marks.clone());
                match tag {
                    Tag::Emphasis => self.marks.italic = true,
                    Tag::Strong => self.marks.bold = true,
                    _ => self.marks.strike = true,
                }
            }
            Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            } => {
                self.text_block(range.start)?;
                // The text around a link inside another, such as an autolink,
                // is the outer link's.
                self.top().sealed |= !self.links.is_empty();
                self.saved.push(self.marks.clone());
                // The editor keeps references in a link's target and title as
                // written.
                let raw = match link_type {
                    LinkType::Inline if self.src[range.clone()].contains('&') => {
                        inline_link_target(&self.src[range.clone()])
                    }
                    LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
                        self.definitions.get(&label_key(&id)).cloned()
                    }
                    _ => None,
                };
                let (href, title) = match (raw, link_type) {
                    (Some(raw), _) => raw,
                    (None, LinkType::Email) => (format!("mailto:{dest_url}"), title.into_string()),
                    (None, _) => (dest_url.into_string(), title.into_string()),
                };
                let title = (!title.is_empty()).then_some(title);
                self.marks.link = Some((href, title));
                let pieces = self.top().pieces.len();
                self.links.push((pieces, range));
            }
            Tag::Image {
                dest_url, title, ..
            } => {
                self.text_block(range.start)?;
                self.image = Some(Image {
                    src: dest_url.into_string(),
                    title: title.into_string(),
                    alt: String::new(),
                    open: 1,
                });
            }
            _ => {}
        }
        Ok(())
    }

    /// The columns an item's content sits past its container's content.
    /// Also whether the item's first line holds only its marker.
    fn item_indent(&self, start: usize) -> (usize, bool) {
        let before = self.kept_indent(self.line_start(start), start);
        // An item that starts on its parent item's line sits at its start.
        let before = if before.bytes().all(|byte| byte == b' ') {
            before.len()
        } else {
            0
        };
        let rest = &self.src[start..];
        let lead = rest.bytes().take_while(|byte| *byte == b' ').count();
        let rest = &rest[lead..];
        let marker = rest.bytes().take_while(u8::is_ascii_digit).count() + 1;
        let after = &rest[marker.min(rest.len())..];
        let spaces = after.bytes().take_while(|byte| *byte == b' ').count();
        let blank = after[spaces..].starts_with('\n') || after[spaces..].is_empty();
        let spaces = if blank || spaces > 4 { 1 } else { spaces };
        (before + lead + marker + spaces, blank)
    }

    fn take_annotation(&mut self, table: usize) -> Vec<(usize, i64)> {
        let Some((frame, block, heights, end)) = self.annotation.take() else {
            return Vec::new();
        };
        let between = &self.src[end.min(table)..table];
        let container = self
            .frames
            .iter()
            .rposition(|frame| !frame.kind.holds_text())
            .expect("the body frame");
        if container == frame
            && self.frames[frame].blocks.len() == block + 1
            && between.bytes().all(|byte| byte == b'\n')
        {
            self.frames[frame].blocks.pop();
            heights
        } else {
            Vec::new()
        }
    }

    fn end(&mut self, tag: TagEnd, range: Range<usize>) -> Result<(), Unreadable> {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) => {
                let frame = self.frames.pop().expect("a text block");
                let blocks = match frame.kind {
                    Kind::Heading(level) => {
                        let children = children(self.inline_pieces(frame, None, false));
                        vec![element(
                            "heading",
                            vec![("level", Any::from(level))],
                            children,
                        )]
                    }
                    _ => match written_definition(&self.src[range.clone()]) {
                        Some(text) => vec![text_paragraph(text)],
                        None => self.finish_paragraph(frame),
                    },
                };
                for block in blocks {
                    self.push_block(block);
                }
                self.block_ends(range.end);
            }
            TagEnd::TableCell => {
                let frame = self.frames.pop().expect("a cell");
                let children = children(self.inline_pieces(frame, None, false));
                self.push_block(paragraph(children));
            }
            TagEnd::TableHead | TagEnd::TableRow => {
                let frame = self.frames.pop().expect("a row");
                let cells = frame
                    .blocks
                    .into_iter()
                    .map(|paragraph| {
                        element("tableCell", Vec::new(), vec![Child::Element(paragraph)])
                    })
                    .collect::<Vec<_>>();
                self.push_block(element(
                    "tableRow",
                    Vec::new(),
                    cells.into_iter().map(Child::Element).collect(),
                ));
            }
            TagEnd::Table => {
                let frame = self.frames.pop().expect("a table");
                let Kind::Table(alignments, heights) = frame.kind else {
                    unreachable!("a table frame");
                };
                let mut rows = frame.blocks;
                for (index, row) in rows.iter_mut().enumerate() {
                    let tag = if index == 0 {
                        "tableHeader"
                    } else {
                        "tableCell"
                    };
                    for (column, cell) in row.children.iter_mut().enumerate() {
                        let Child::Element(cell) = cell else { continue };
                        cell.tag = tag;
                        cell.attrs =
                            vec![("colspan", Any::from(1_i64)), ("rowspan", Any::from(1_i64))];
                        let align = match alignments.get(column) {
                            Some(Alignment::Left) => Some("left"),
                            Some(Alignment::Center) => Some("center"),
                            Some(Alignment::Right) => Some("right"),
                            _ => None,
                        };
                        if let Some(align) = align {
                            cell.attrs.push(("align", Any::from(align)));
                        }
                    }
                }
                for (row, height) in heights {
                    if let Some(row) = rows.get_mut(row) {
                        row.attrs.push(("height", Any::from(height)));
                    }
                }
                self.push_block(element(
                    "table",
                    Vec::new(),
                    rows.into_iter().map(Child::Element).collect(),
                ));
                self.block_ends(range.end);
            }
            TagEnd::BlockQuote(_) => {
                self.close_implicit();
                self.flush_definitions(range.end);
                let frame = self.frames.pop().expect("a quote");
                let end = frame.last_end;
                let callout = self.callouts.pop().expect("a quote");
                // A callout around this one reads its body again, this callout
                // with it, so reading it now would take time that doubles
                // with each level.
                let block = if callout && self.callouts.contains(&true) {
                    element("blockquote", Vec::new(), Vec::new())
                } else {
                    self.quote(frame, &range)?
                };
                self.push_block(block);
                self.block_ends(end.unwrap_or(range.end));
            }
            TagEnd::CodeBlock => {
                let frame = self.frames.pop().expect("a code block");
                let Kind::CodeBlock(language) = frame.kind else {
                    unreachable!("a code block frame");
                };
                let mut text = frame.text;
                if text.ends_with('\n') {
                    text.pop();
                }
                let attrs = if language.is_empty() {
                    Vec::new()
                } else {
                    vec![("language", Any::from(language))]
                };
                let children = if text.is_empty() {
                    Vec::new()
                } else {
                    vec![Child::Text(vec![(text, Marks::default())])]
                };
                self.push_block(element("codeBlock", attrs, children));
                self.block_ends(range.end);
            }
            TagEnd::HtmlBlock => {
                let frame = self.frames.pop().expect("an HTML block");
                let text = frame.text.trim_end().to_owned();
                if text.is_empty() {
                    return Ok(());
                }
                self.block_ends(range.end);
                let heights = (!text.contains('\n'))
                    .then(|| super::parse_table_row_heights(text.trim_end()))
                    .flatten();
                let raw = renders_markup(&text);
                let mut block = text_paragraph(text);
                if let Some(Child::Text(runs)) = block.children.first_mut() {
                    runs[0].1.raw = raw;
                }
                self.container().blocks.push(block);
                if let Some(heights) = heights {
                    let container = self
                        .frames
                        .iter()
                        .rposition(|frame| !frame.kind.holds_text())
                        .expect("the body frame");
                    let block = self.frames[container].blocks.len() - 1;
                    self.annotation = Some((container, block, heights, range.end));
                }
            }
            TagEnd::List(_) => {
                self.close_implicit();
                let frame = self.frames.pop().expect("a list");
                let Kind::List(start) = frame.kind else {
                    unreachable!("a list frame");
                };
                for list in lists(start, frame.blocks) {
                    self.push_block(list);
                }
                // The blank lines after a list are the container's.
                self.container().last_end = frame.last_end;
            }
            TagEnd::Item => {
                self.close_implicit();
                self.flush_definitions(range.end);
                let frame = self.frames.pop().expect("an item");
                let Kind::Item {
                    task, blank_first, ..
                } = frame.kind
                else {
                    unreachable!("an item frame");
                };
                let mut blocks = frame.blocks;
                // The editor reads an item whose text starts on the next line
                // with an empty paragraph first.
                if (blank_first && !blocks.is_empty())
                    || blocks.first().is_none_or(|block| block.tag != "paragraph")
                {
                    blocks.insert(0, paragraph(Vec::new()));
                }
                let end = frame.last_end.unwrap_or(range.start + 1);
                let children = blocks.into_iter().map(Child::Element).collect();
                let item = match task {
                    Some(checked) => {
                        element("taskItem", vec![("checked", Any::Bool(checked))], children)
                    }
                    None => element("listItem", Vec::new(), children),
                };
                let list = self.frames.last_mut().expect("a list");
                list.blocks.push(item);
                list.last_end = Some(end);
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.marks = self.saved.pop().unwrap_or_default();
                let frame = self.top();
                frame.covered = frame.covered.max(range.end);
            }
            TagEnd::Link => {
                self.marks = self.saved.pop().unwrap_or_default();
                let frame = self.top();
                frame.covered = frame.covered.max(range.end);
                if let Some((pieces, source)) = self.links.pop() {
                    // The editor keeps a link with no text as the text it is.
                    if self.top().pieces.len() == pieces {
                        let text = &self.src[source.clone()];
                        if text.contains('\n') {
                            // Its later lines lose their containers and
                            // indentation, as a paragraph's lines do.
                            let mut lines = text.split('\n');
                            let mut kept = lines.next().unwrap_or("").to_owned();
                            for line in lines {
                                kept.push('\n');
                                kept.push_str(
                                    self.strip_containers(line).trim_start_matches([' ', '\t']),
                                );
                            }
                            self.push_text(&kept, None, &source);
                        } else {
                            self.push_text(text, Some(source.start), &source);
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// A quote, or a callout when its first line is a callout header. A
    /// callout's body is read on its own, as the editor reads it.
    fn quote(&mut self, frame: Frame, range: &Range<usize>) -> Result<Element, Unreadable> {
        let source = &self.src[range.clone()];
        let mut lines = source.split('\n');
        let first = strip_quote_marker(lines.next().unwrap_or(""));
        let Some((kind, fold, title)) = callout_header(first) else {
            let children = frame.blocks.into_iter().map(Child::Element).collect();
            return Ok(element("blockquote", Vec::new(), children));
        };
        // Each line drops what the containers around the quote put before
        // it, then the quote's own marker.
        let body = lines
            .map(|line| {
                let line = self.strip_containers(line);
                if line.trim_start_matches(' ').starts_with('>') {
                    strip_quote_marker(line)
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut blocks = if body.trim().is_empty() {
            Vec::new()
        } else {
            read_blocks(
                &body,
                self.depth + self.frames.len(),
                self.quotes() + 1,
                &self.definitions,
            )?
        };
        if blocks.is_empty() {
            blocks.push(paragraph(Vec::new()));
        }
        let kind = kind.trim();
        let attrs = vec![
            (
                "calloutType",
                Any::from(if kind.is_empty() { "note" } else { kind }),
            ),
            ("title", Any::from(title.trim())),
            ("fold", Any::from(fold)),
        ];
        Ok(element(
            "callout",
            attrs,
            blocks.into_iter().map(Child::Element).collect(),
        ))
    }

    /// A text block's pieces after the inline passes. A block that holds
    /// syntax the reader can't map for sure keeps its source as one sealed
    /// piece, written back exactly, after what comes before its first
    /// source and before `trailing`.
    ///
    /// Where no math block can stand (`math` false), such as in a heading or
    /// a cell, a `$$` span is sealed as its source.
    fn inline_pieces(&self, frame: Frame, trailing: Option<Piece>, math: bool) -> Vec<Piece> {
        let lead = frame
            .content
            .map_or(Vec::new(), |(index, _)| frame.pieces[..index].to_vec());
        let mut pieces = frame.pieces;
        pieces.extend(trailing.clone());
        tag_span_references(&mut pieces, &frame.brackets);
        let (mut pieces, unsure) = inline_syntax(merge(pieces), self.src);
        if !math {
            pieces = pieces
                .into_iter()
                .map(|piece| match piece {
                    Piece::DisplayMath { source, .. } => self.sealed_formula(&source),
                    piece => piece,
                })
                .collect();
        }
        let Some((_, start)) = frame.content.filter(|_| frame.sealed || unsure) else {
            return pieces;
        };
        let source = self.unprefixed(&(start..frame.covered.max(start)));
        let mut sealed = lead;
        sealed.push(Piece::Node(element(
            "rawInline",
            vec![("source", Any::from(source))],
            Vec::new(),
        )));
        sealed.extend(trailing);
        sealed
    }

    /// A paragraph's elements. A `$$` span alone on its lines is a math
    /// block, which splits the paragraph around it.
    fn finish_paragraph(&self, frame: Frame) -> Vec<Element> {
        // The editor keeps the spaces that end a paragraph's last line.
        let rest = &self.src[frame.covered.min(self.src.len())..];
        let spaces = rest
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        let trailing = (spaces > 0
            && !frame.pieces.is_empty()
            && matches!(rest.as_bytes().get(spaces), None | Some(b'\n')))
        .then(|| Piece::Text {
            text: rest[..spaces].to_owned(),
            marks: Marks::default(),
            at: Some(frame.covered),
        });
        let pieces = self.inline_pieces(frame, trailing, true);
        if !pieces
            .iter()
            .any(|piece| matches!(piece, Piece::DisplayMath { .. }))
        {
            return vec![paragraph(children(pieces))];
        }
        let mut blocks = Vec::new();
        let mut current: Vec<Piece> = Vec::new();
        let count = pieces.len();
        let mut pieces = pieces.into_iter().enumerate().peekable();
        while let Some((index, piece)) = pieces.next() {
            let Piece::DisplayMath { tex, source } = piece else {
                current.push(piece);
                continue;
            };
            let line_start = index == 0
                || matches!(current.last(), Some(Piece::Text { text, .. }) if text.ends_with('\n'));
            let line_end = index + 1 == count
                || matches!(pieces.peek(), Some((_, Piece::Text { text, .. })) if text.starts_with('\n'));
            if !(line_start && line_end) {
                current.push(self.sealed_formula(&source));
                continue;
            }
            if let Some(Piece::Text { text, .. }) = current.last_mut() {
                text.pop();
                if text.is_empty() {
                    current.pop();
                }
            }
            if !current.is_empty() {
                blocks.push(paragraph(children(std::mem::take(&mut current))));
            }
            blocks.push(element(
                "mathBlock",
                vec![("tex", Any::from(tex))],
                Vec::new(),
            ));
            if let Some((_, Piece::Text { text, .. })) = pieces.peek_mut() {
                let rest = text
                    .trim_start_matches('\n')
                    .trim_start_matches([' ', '\t'])
                    .to_owned();
                *text = rest;
            }
        }
        if !current.is_empty() || blocks.is_empty() {
            blocks.push(paragraph(children(current)));
        }
        blocks
    }
}

/// Group a bullet list's items as the editor does: a run of task items is a
/// task list and a run of other items a bullet list.
fn lists(start: Option<u64>, items: Vec<Element>) -> Vec<Element> {
    if let Some(start) = start {
        let start = i64::try_from(start).unwrap_or(i64::MAX);
        return vec![element(
            "orderedList",
            vec![("start", Any::from(start))],
            items.into_iter().map(Child::Element).collect(),
        )];
    }
    let mut lists: Vec<Element> = Vec::new();
    for item in items {
        let tag = if item.tag == "taskItem" {
            "taskList"
        } else {
            "bulletList"
        };
        match lists.last_mut() {
            Some(list) if list.tag == tag => list.children.push(Child::Element(item)),
            _ => lists.push(element(tag, Vec::new(), vec![Child::Element(item)])),
        }
    }
    lists
}

fn strip_quote_marker(line: &str) -> &str {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return line;
    }
    match line[spaces..].strip_prefix('>') {
        Some(rest) => rest.strip_prefix(' ').unwrap_or(rest),
        None => line,
    }
}

/// `[!type]fold title`, the editor's callout header.
fn callout_header(line: &str) -> Option<(&str, &'static str, &str)> {
    let rest = line.strip_prefix("[!")?;
    let close = rest.find(']')?;
    let kind = &rest[..close];
    if kind.is_empty() || kind.contains('\n') {
        return None;
    }
    let rest = &rest[close + 1..];
    let (fold, rest) = match rest.as_bytes().first() {
        Some(b'+') => ("+", &rest[1..]),
        Some(b'-') => ("-", &rest[1..]),
        _ => ("", rest),
    };
    Some((kind, fold, rest.trim_start_matches([' ', '\t'])))
}

fn closing_tag_name(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix("</")?.trim_start();
    let name = tag_name(rest);
    (!name.is_empty()).then_some(name)
}

fn opening_tag_name(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix('<')?.trim_start();
    let name = tag_name(rest);
    let after = rest[name.len()..].chars().next();
    (!name.is_empty()
        && after
            .is_none_or(|character| character.is_whitespace() || matches!(character, '>' | '/')))
    .then_some(name)
}

fn tag_name(text: &str) -> &str {
    let end = text
        .find(|character: char| {
            !(character.is_alphanumeric() || character == '_' || character == '-')
        })
        .unwrap_or(text.len());
    &text[..end]
}

/// The text of a one-line paragraph that is a kept reference definition as
/// the writer writes it, with its punctuation as references so it is not a
/// definition again. The editor reads it back as that text.
fn written_definition(raw: &str) -> Option<String> {
    let raw = raw.trim_end_matches([' ', '\t', '\n']);
    if raw.contains('\n') || !raw.starts_with("&#91;") {
        return None;
    }
    let mut text = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        text.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let end = after.find(';')?;
        let name = &after[..end];
        let character = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            _ => char::from_u32(name.strip_prefix('#')?.parse().ok()?)?,
        };
        text.push(character);
        rest = &after[end + 1..];
    }
    text.push_str(rest);
    let written: String = text
        .chars()
        .map(|character| match character {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"'..='.' | ':'..='>' | '@' | '['..='`' | '{'..='~' | '\r' | '\u{a0}' => {
                format!("&#{};", u32::from(character))
            }
            other => other.to_string(),
        })
        .collect();
    let definitions = Parser::new_ext(&text, options());
    let is_definition = definitions
        .reference_definitions()
        .iter()
        .any(|(_, definition)| {
            definition.span.start == 0 && definition.span.end >= text.trim_end().len()
        });
    (written == raw && is_definition).then_some(text)
}

/// The character a reference reads as, for the references the editor's
/// reader decodes in text. Others stay the text they spell.
/// The editor reads a block's tag span, from its first `&lt;` that opens a
/// tag to its last `&gt;`, with each reference the writer spells there as
/// its character: ASCII punctuation, white space, and NBSP.
fn tag_span_references(pieces: &mut [Piece], brackets: &[usize]) {
    fn text(piece: &Piece) -> Option<&str> {
        match piece {
            Piece::Text { text, marks, .. } if !marks.code => Some(text),
            _ => None,
        }
    }
    let start = brackets.iter().copied().find(|&index| {
        text(&pieces[index]) == Some("<")
            && pieces[index + 1..]
                .iter()
                .find_map(|piece| text(piece).and_then(|text| text.chars().next()))
                .is_some_and(|next| matches!(next, '!' | '/' | '?') || next.is_ascii_alphabetic())
    });
    let end = brackets
        .iter()
        .copied()
        .rfind(|&index| text(&pieces[index]) == Some(">"));
    let (Some(start), Some(end)) = (start, end) else {
        return;
    };
    for piece in pieces.iter_mut().take(end).skip(start + 1) {
        let Piece::Text { text, marks, at } = piece else {
            continue;
        };
        let decoded = text
            .strip_prefix("&#")
            .and_then(|rest| rest.strip_suffix(';'))
            .filter(|code| !code.starts_with('0'))
            .and_then(|code| code.parse::<u32>().ok())
            .filter(
                |code| matches!(code, 9 | 10 | 13 | 32..=47 | 58..=64 | 91..=96 | 123..=126 | 160),
            )
            .and_then(char::from_u32);
        if let (Some(decoded), false) = (decoded, marks.code) {
            *text = decoded.to_string();
            marks.raw = false;
            *at = None;
        }
    }
}

fn decoded_reference(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "#13" => "\r",
        "#35" => "#",
        "#36" => "$",
        "#41" => ")",
        "#42" => "*",
        "#43" => "+",
        "#45" => "-",
        "#46" => ".",
        "#61" => "=",
        "#91" => "[",
        "#95" => "_",
        "#96" => "`",
        "#126" => "~",
        "#160" => "\u{a0}",
        _ => return None,
    })
}

/// The first `character` in `text` that no backslash escapes.
fn unescaped(text: &str, character: char) -> Option<usize> {
    let mut chars = text.char_indices();
    while let Some((at, next)) = chars.next() {
        if next == '\\' {
            chars.next();
        } else if next == character {
            return Some(at);
        }
    }
    None
}

/// Join neighbouring text that has the same marks.
fn merge(mut pieces: Vec<Piece>) -> Vec<Piece> {
    pieces.dedup_by(|piece, kept| {
        let (
            Piece::Text {
                text: next,
                marks: next_marks,
                at: next_at,
            },
            Piece::Text { text, marks, at },
        ) = (piece, kept)
        else {
            return false;
        };
        // Source text joins only the source text right after it, so each
        // piece with an offset is still the source as written there.
        // A piece without one that starts with `<` joins nothing, so each such
        // piece that holds a tag is still an inline HTML run as written.
        let joins = match (*at, *next_at) {
            (Some(at), Some(next_at)) => at + text.len() == next_at,
            (None, None) => !text.starts_with('<') && !next.starts_with('<'),
            _ => false,
        };
        let joins = joins && *marks == *next_marks;
        if joins {
            text.push_str(next);
        }
        joins
    });
    pieces
}

/// The text's children: each run of text one text node.
fn children(pieces: Vec<Piece>) -> Vec<Child> {
    let mut children = Vec::new();
    let mut runs: Vec<(String, Marks)> = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Text { text, marks, .. } => {
                if text.is_empty() {
                    continue;
                }
                match runs.last_mut() {
                    Some((run, run_marks)) if *run_marks == marks => run.push_str(&text),
                    _ => runs.push((text, marks)),
                }
            }
            Piece::Node(node) => {
                if !runs.is_empty() {
                    children.push(Child::Text(std::mem::take(&mut runs)));
                }
                children.push(Child::Element(node));
            }
            Piece::Escaped { value, .. } => {
                if !runs.is_empty() {
                    children.push(Child::Text(std::mem::take(&mut runs)));
                }
                children.push(Child::Element(element(
                    "escapedPunctuation",
                    vec![("value", Any::from(value))],
                    Vec::new(),
                )));
            }
            Piece::DisplayMath { .. } => unreachable!("math is a block or text by now"),
        }
    }
    if !runs.is_empty() {
        children.push(Child::Text(runs));
    }
    children
}

/// The editor's inline syntax pulldown-cmark doesn't read: wikilinks,
/// atoms, highlight, underline and links from bare URLs. Each is read only
/// in text that is still its source. Also whether the text holds a wikilink,
/// an atom or a formula inside a mark or a link, which the document can't
/// hold as written.
fn inline_syntax(pieces: Vec<Piece>, src: &str) -> (Vec<Piece>, bool) {
    // Each syntax here holds one of these in source text.
    let candidate = |text: &str| {
        let bytes = text.as_bytes();
        (0..bytes.len()).any(|at| {
            let rest = &bytes[at..];
            match bytes[at] {
                b'[' | b'{' | b'=' | b'+' => rest.get(1) == Some(&bytes[at]),
                b':' => rest.starts_with(b"://"),
                b'@' => true,
                b'w' | b'W' => rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(b"www."),
                _ => false,
            }
        })
    };
    if !pieces
        .iter()
        .any(|piece| plain_source(piece).is_some_and(|(text, ..)| candidate(text)))
    {
        return (pieces, false);
    }
    let mut unsure = false;
    let pieces = nodes_in_text(pieces, &mut unsure);
    let pieces = paired(pieces, src, Pair::Highlight, &mut unsure);
    let pieces = paired(pieces, src, Pair::Underline, &mut unsure);
    (bare_links(pieces), unsure)
}

/// Whether the document drops the marks around this node, which the source
/// shows on it.
fn holds_no_marks(node: &Element) -> bool {
    matches!(node.tag, "wikilink" | "inlineAtom" | "mathInline" | "image")
}

fn plain_source(piece: &Piece) -> Option<(&str, usize, &Marks)> {
    match piece {
        Piece::Text {
            text,
            marks,
            at: Some(at),
        } if !marks.code => Some((text, *at, marks)),
        _ => None,
    }
}

/// Wikilinks and atoms in source text.
fn nodes_in_text(pieces: Vec<Piece>, unsure: &mut bool) -> Vec<Piece> {
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let Some((text, at, marks)) = plain_source(&piece) else {
            out.push(piece);
            continue;
        };
        if !text.contains("[[") && !text.contains("{{atom:") {
            out.push(piece);
            continue;
        }
        let (text, marks) = (text.to_owned(), marks.clone());
        let mut from = 0;
        let mut index = 0;
        while index < text.len() {
            let rest = &text[index..];
            let found = if rest.starts_with("[[") && !text[..index].ends_with('\\') {
                wikilink(rest)
            } else if rest.starts_with("{{atom:") {
                atom(rest)
            } else {
                None
            };
            let Some((length, node)) = found else {
                index += rest.chars().next().map_or(1, char::len_utf8);
                continue;
            };
            if index > from {
                out.push(Piece::Text {
                    text: text[from..index].to_owned(),
                    marks: marks.clone(),
                    at: Some(at + from),
                });
            }
            // A node can't keep a mark or a link around it.
            *unsure |= !marks.writes_as(&Marks::default());
            out.push(Piece::Node(node));
            index += length;
            from = index;
        }
        if from < text.len() {
            out.push(Piece::Text {
                text: text[from..].to_owned(),
                marks,
                at: Some(at + from),
            });
        }
    }
    out
}

fn wikilink(text: &str) -> Option<(usize, Element)> {
    let inner_start = 2;
    let mut chars = text[inner_start..].char_indices();
    let mut close = None;
    while let Some((at, character)) = chars.next() {
        match character {
            '\\' => {
                chars.next();
            }
            '\n' => return None,
            ']' if text[inner_start + at..].starts_with("]]") => {
                close = Some(inner_start + at);
                break;
            }
            ']' => return None,
            _ => {}
        }
    }
    let close = close?;
    let inner = &text[inner_start..close];
    if inner.is_empty() {
        return None;
    }
    let (target, label) = match unescaped(inner, '|') {
        Some(bar) => (
            unescape_wikilink(&inner[..bar]),
            Some(unescape_wikilink(&inner[bar + 1..])),
        ),
        None => (unescape_wikilink(inner), None),
    };
    let mut attrs = vec![("target", Any::from(target))];
    if let Some(label) = label {
        attrs.push(("label", Any::from(label)));
    }
    Some((close + 2, element("wikilink", attrs, Vec::new())))
}

fn unescape_wikilink(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && matches!(chars.peek(), Some('\\' | ']' | '|')) {
            out.push(chars.next().expect("the escaped character"));
        } else {
            out.push(character);
        }
    }
    out
}

fn atom(text: &str) -> Option<(usize, Element)> {
    let rest = &text["{{atom:".len()..];
    let id_end = rest
        .find(|character: char| character == '}' || character.is_whitespace())
        .unwrap_or(rest.len());
    if id_end == 0 {
        return None;
    }
    let params_end = id_end + rest[id_end..].find('}')?;
    if !rest[params_end..].starts_with("}}") {
        return None;
    }
    let length = "{{atom:".len() + params_end + 2;
    let attrs = vec![
        ("atomId", Any::from(&rest[..id_end])),
        ("params", Any::from(rest[id_end..params_end].trim())),
        ("source", Any::from(&text[2..length - 2])),
    ];
    Some((length, element("inlineAtom", attrs, Vec::new())))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pair {
    Highlight,
    Underline,
}

/// `==highlight==` or `++underline++`, read on the source as the editor's
/// tokenizers do, applied to the pieces between the delimiters.
fn paired(pieces: Vec<Piece>, src: &str, pair: Pair, unsure: &mut bool) -> Vec<Piece> {
    let delimiter = match pair {
        Pair::Highlight => "==",
        Pair::Underline => "++",
    };
    let pairs = pairs(&pieces, src, delimiter, pair);
    if pairs.is_empty() {
        return pieces;
    }
    let mut cuts: Vec<usize> = pairs
        .iter()
        .flat_map(|&(open, close)| [open, open + 2, close, close + 2])
        .collect();
    cuts.dedup();
    let mut out = Vec::with_capacity(pieces.len() + cuts.len());
    let mut next = 0;
    let mut inside = false;
    for piece in pieces {
        for piece in split(piece, &cuts) {
            let at = match &piece {
                Piece::Text { at: Some(at), .. } => Some(*at),
                _ => None,
            };
            match pairs.get(next) {
                Some(&(open, _)) if !inside && at == Some(open) => inside = true,
                Some(&(_, close)) if inside && at == Some(close) => {
                    inside = false;
                    next += 1;
                }
                _ if inside => {
                    // A node or a formula can't keep the mark.
                    *unsure |= matches!(&piece, Piece::DisplayMath { .. })
                        || matches!(&piece, Piece::Node(node) if holds_no_marks(node));
                    out.push(mark(piece, src, pair));
                }
                _ => out.push(piece),
            }
        }
    }
    out
}

/// A source text piece cut at each of `cuts` that falls inside it.
fn split(piece: Piece, cuts: &[usize]) -> Vec<Piece> {
    let Piece::Text {
        mut text,
        marks,
        at: Some(at),
    } = piece
    else {
        return vec![piece];
    };
    let first = cuts.partition_point(|&cut| cut <= at);
    let last = cuts.partition_point(|&cut| cut < at + text.len());
    let mut pieces = Vec::with_capacity(last - first + 1);
    for &cut in cuts[first..last].iter().rev() {
        let rest = text.split_off(cut - at);
        pieces.push(Piece::Text {
            text: rest,
            marks: marks.clone(),
            at: Some(cut),
        });
    }
    pieces.push(Piece::Text {
        text,
        marks,
        at: Some(at),
    });
    pieces.reverse();
    pieces
}

/// A piece between a pair's delimiters, with the pair's mark.
fn mark(mut piece: Piece, src: &str, pair: Pair) -> Piece {
    match &mut piece {
        Piece::Text { text, marks, at } => match pair {
            Pair::Highlight => {
                marks.highlight = true;
                // The editor reads every `\=` in a highlight's source as
                // `=`, also inside code and raw HTML.
                // An inline HTML run is source with no offset kept, and
                // `merge` joins it to nothing.
                let raw = marks.code
                    || match at {
                        Some(at) => src.get(*at..*at + text.len()) == Some(text.as_str()),
                        None => text.starts_with('<'),
                    };
                if raw && text.contains("\\=") {
                    *text = text.replace("\\=", "=");
                    *at = None;
                }
            }
            Pair::Underline => marks.underline = true,
        },
        // The editor's highlight keeps `\=` inside it as `=`, with the marks
        // around it.
        Piece::Escaped { value, marks } if pair == Pair::Highlight && value == "=" => {
            piece = Piece::Text {
                text: "=".to_owned(),
                marks: Marks {
                    highlight: true,
                    ..marks.clone()
                },
                at: None,
            };
        }
        _ => {}
    }
    piece
}

/// The source offsets of each delimiter pair, in order. Each pair is found
/// after the one before it closes.
fn pairs(pieces: &[Piece], src: &str, delimiter: &str, pair: Pair) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let Some(end) = pieces.iter().rev().find_map(|piece| match piece {
        Piece::Text {
            text, at: Some(at), ..
        } => Some(at + text.len()),
        _ => None,
    }) else {
        return pairs;
    };
    // The source spans of plain text, in source order.
    let mut spans: Vec<(usize, usize)> = pieces
        .iter()
        .filter_map(plain_source)
        .map(|(text, at, _)| (at, at + text.len()))
        .collect();
    spans.sort_unstable();
    // Whether one plain text span holds the delimiter at `offset`.
    let inside = |offset: usize| {
        let index = spans.partition_point(|&(start, _)| start <= offset);
        index > 0 && offset + 2 <= spans[index - 1].1
    };
    let mut search = 0;
    for piece in pieces {
        let Some((text, at, _)) = plain_source(piece) else {
            continue;
        };
        let mut from = 0;
        while let Some(found) = text[from..].find(delimiter) {
            let offset = at + from + found;
            from += found + 1;
            if offset < search {
                continue;
            }
            let before = src[..offset].chars().next_back();
            let after = src[offset + 2..].chars().next();
            let opens = match pair {
                Pair::Highlight => {
                    before != Some('\\')
                        && before != Some('=')
                        && after
                            .is_some_and(|character| !character.is_whitespace() && character != '=')
                }
                Pair::Underline => after.is_some(),
            };
            if !opens {
                continue;
            }
            if let Some(close) =
                closing(src, offset, end, delimiter, pair).filter(|&close| inside(close))
            {
                pairs.push((offset, close));
                search = close + 2;
            }
        }
    }
    pairs
}

fn closing(src: &str, open: usize, end: usize, delimiter: &str, pair: Pair) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut index = open + 2;
    if pair == Pair::Underline {
        // `++` needs at least one character inside.
        index += src[index..].chars().next().map_or(1, char::len_utf8);
    }
    while index + 2 <= end {
        if pair == Pair::Highlight && bytes[index] == b'\\' {
            index += 1 + src[index + 1..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        if src[index..].starts_with(delimiter) {
            if pair == Pair::Highlight {
                let before = src[..index].chars().next_back();
                if index == open + 2 || before.is_some_and(char::is_whitespace) {
                    return None;
                }
            }
            return Some(index);
        }
        index += src[index..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

/// Links from bare URLs and email addresses, as marked's GFM rules find
/// them, in text that isn't already a link or code.
fn bare_links(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let found = match &piece {
            Piece::Text {
                text,
                marks,
                at: Some(_),
            } if marks.link.is_none() && !marks.code => {
                (text.contains("://") || text.contains('@') || contains_ignore_case(text, "www."))
                    .then(|| (text.clone(), marks.clone()))
            }
            _ => None,
        };
        let Some((text, marks)) = found else {
            out.push(piece);
            continue;
        };
        let mut from = 0;
        let mut index = 0;
        while index < text.len() {
            let Some((length, href)) = bare_link(&text, index) else {
                index += text[index..].chars().next().map_or(1, char::len_utf8);
                continue;
            };
            if index > from {
                out.push(Piece::Text {
                    text: text[from..index].to_owned(),
                    marks: marks.clone(),
                    at: None,
                });
            }
            let mut link = marks.clone();
            link.link = Some((href, None));
            out.push(Piece::Text {
                text: text[index..index + length].to_owned(),
                marks: link,
                at: None,
            });
            index += length;
            from = index;
        }
        if from < text.len() {
            out.push(Piece::Text {
                text: text[from..].to_owned(),
                marks,
                at: None,
            });
        }
    }
    out
}

/// Whether source text among `pieces` holds a URL or email address that
/// `bare_links` would link.
fn holds_bare_link(pieces: &[Piece]) -> bool {
    pieces.iter().any(|piece| match piece {
        Piece::Text {
            text,
            marks,
            at: Some(_),
        } if marks.link.is_none() && !marks.code => {
            (text.contains("://") || text.contains('@') || contains_ignore_case(text, "www."))
                && text
                    .char_indices()
                    .any(|(index, _)| bare_link(text, index).is_some())
        }
        _ => false,
    })
}

fn contains_ignore_case(text: &str, needle: &str) -> bool {
    text.as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn email_local(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"._+-".contains(&byte)
}

fn email_boundary(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?_`{|}~-".contains(&byte)
}

/// A bare URL or email address at `index`: its length and href.
fn bare_link(text: &str, index: usize) -> Option<(usize, String)> {
    let rest = &text[index..];
    let lower = |prefix: &str| {
        rest.len() >= prefix.len()
            && rest.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
    };
    let prefix = ["https://", "http://", "ftp://", "www."]
        .into_iter()
        .find(|prefix| lower(prefix));
    if let Some(prefix) = prefix {
        let after = &rest[prefix.len()..];
        let host = after
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            .count();
        if host == 0 {
            return None;
        }
        let length = prefix.len()
            + after
                .find(|character: char| character.is_whitespace() || character == '<')
                .unwrap_or(after.len());
        let link = backpedal(&rest[..length]);
        if link.len() <= prefix.len() {
            return None;
        }
        let href = if &rest[..4] == "www." {
            format!("http://{link}")
        } else {
            link.to_owned()
        };
        return Some((link.len(), href));
    }
    // An email address starts after a character that can't be in one.
    if index > 0 && email_boundary(text.as_bytes()[index - 1]) {
        return None;
    }
    let local = rest.bytes().take_while(|byte| email_local(*byte)).count();
    if local == 0 || rest.as_bytes().get(local) != Some(&b'@') {
        return None;
    }
    let domain = &rest[local + 1..];
    let label = |text: &str| {
        text.bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
            .count()
    };
    let first = label(domain);
    if first == 0 {
        return None;
    }
    let mut end = first;
    let mut parts = 0;
    while domain[end..].starts_with('.') {
        let next = label(&domain[end + 1..]);
        let part = &domain[end + 1..end + 1 + next];
        // Each later part ends with a letter or digit.
        let trimmed = part.trim_end_matches(['-', '_']);
        if trimmed.is_empty() {
            break;
        }
        end += 1 + trimmed.len();
        parts += 1;
        if trimmed.len() != part.len() {
            break;
        }
    }
    if parts == 0 || domain[end..].starts_with(['-', '_']) {
        return None;
    }
    let length = local + 1 + end;
    Some((length, format!("mailto:{}", &rest[..length])))
}

/// marked's trailing-punctuation rule for a bare URL.
fn backpedal(mut link: &str) -> &str {
    loop {
        let before = link;
        if let Some(last) = link.chars().next_back() {
            if "?!.,:;*_'\"~".contains(last) {
                link = &link[..link.len() - 1];
            } else if last == ')' {
                let opens = link.matches('(').count();
                let closes = link.matches(')').count();
                if closes > opens {
                    link = &link[..link.len() - 1];
                }
            } else if last == ';' {
                // handled above
            }
        }
        if let Some(amp) = link.rfind('&') {
            let entity = &link[amp + 1..];
            if entity.len() > 1
                && entity.ends_with(';')
                && entity[..entity.len() - 1]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric())
            {
                link = &link[..amp];
            }
        }
        if link == before {
            return link;
        }
    }
}

/// Backslash escapes undone, as marked undoes them in a link's target.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            out.push(chars.next().expect("the escaped character"));
        } else {
            out.push(character);
        }
    }
    out
}

/// An inline link's target and title as written, from its source.
fn inline_link_target(source: &str) -> Option<(String, String)> {
    let bytes = source.as_bytes();
    let mut depth = 0;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return source[index + 1..].strip_prefix('(').and_then(link_target);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// A link target and optional title, as they follow `(` or a definition's
/// `]:`, with escapes undone and references kept.
fn link_target(text: &str) -> Option<(String, String)> {
    let text = text.trim_start();
    let (dest, rest) = if let Some(rest) = text.strip_prefix('<') {
        let end = rest.find(['>', '\n'])?;
        (&rest[..end], &rest[end + 1..])
    } else {
        let bytes = text.as_bytes();
        let (mut index, mut parens) = (0, 0usize);
        while index < bytes.len() {
            match bytes[index] {
                b'\\' => index += 1,
                b'(' => parens += 1,
                b')' if parens == 0 => break,
                b')' => parens -= 1,
                byte if byte.is_ascii_whitespace() => break,
                _ => {}
            }
            index += 1;
        }
        let index = index.min(text.len());
        (&text[..index], &text[index..])
    };
    let rest = rest.trim_start();
    let close = match rest.as_bytes().first() {
        Some(b'"') => Some('"'),
        Some(b'\'') => Some('\''),
        Some(b'(') => Some(')'),
        _ => None,
    };
    let title = match close {
        Some(close) => {
            let inner = &rest[1..];
            let mut end = None;
            let mut chars = inner.char_indices();
            while let Some((at, character)) = chars.next() {
                if character == '\\' {
                    chars.next();
                } else if character == close {
                    end = Some(at);
                    break;
                }
            }
            unescape(&inner[..end?])
        }
        None => String::new(),
    };
    Some((unescape(dest), title))
}
