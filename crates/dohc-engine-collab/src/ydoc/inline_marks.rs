use std::cell::{OnceCell, RefCell};
use std::collections::BTreeMap;

use super::held_characters::{
    escape_markers, resolved, write_held_characters, OPAQUE_CLOSE, OPAQUE_OPEN, SCOPE_CLOSE,
    SCOPE_OPEN,
};
use super::{
    active_mark, contains_same_mark, is_js_whitespace, js_value_string, remove_active, set_active,
    split_leading_js_whitespace, split_trailing_js_whitespace, MarkKind, MarkdownMark,
    ProjectionBuffer, ProjectionResult,
};

pub(super) enum Piece {
    Text {
        text: String,
        marks: Vec<MarkdownMark>,
    },
    Node {
        rendered: String,
        hard_break: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Markdown,
    Underscore,
}

fn picky(kind: MarkKind) -> bool {
    matches!(kind, MarkKind::Bold | MarkKind::Italic | MarkKind::Strike)
}

fn starred(kind: MarkKind) -> bool {
    matches!(kind, MarkKind::Bold | MarkKind::Italic)
}

fn loose(character: char) -> bool {
    is_js_whitespace(character)
        || matches!(
            character,
            '!'..=')' | '+'..='/' | ':'..='@' | '['..='^' | '`' | '{'..='}'
        )
}

fn loose_before(written: &str) -> bool {
    let Some(last) = written.chars().next_back() else {
        return true;
    };
    if let Some(body) = written.strip_suffix(';') {
        let digits = body.bytes().rev().take_while(u8::is_ascii_digit).count();
        if digits > 0 && body[..body.len() - digits].ends_with('#') {
            return false;
        }
    }
    loose(last)
}

fn loose_after(written: &str) -> bool {
    let Some(first) = written.chars().next() else {
        return true;
    };
    if written.starts_with("&#") || written.starts_with("&amp;#") {
        return false;
    }
    loose(first)
}

fn ends_with_escape(text: &str) -> bool {
    let mut end = text.chars().rev();
    end.next() == Some(OPAQUE_CLOSE)
        && end
            .next()
            .is_some_and(|character| character.is_ascii_punctuation())
        && end.next() == Some('\\')
        && end.next() == Some(OPAQUE_OPEN)
}

fn delimiter(kind: MarkKind) -> &'static str {
    match kind {
        MarkKind::Link => "[",
        MarkKind::Highlight => "==",
        MarkKind::Bold => "**",
        MarkKind::Italic => "*",
        MarkKind::Strike => "~~",
        MarkKind::Underline => "++",
        MarkKind::Code => unreachable!("inline code marks are rendered before mark serialization"),
    }
}

fn underscores(kind: MarkKind) -> &'static str {
    match kind {
        MarkKind::Bold => "__",
        MarkKind::Italic => "_",
        _ => "",
    }
}

fn opening(mark: &MarkdownMark, mode: Mode) -> String {
    match mode {
        Mode::Underscore => underscores(mark.kind).to_owned(),
        Mode::Markdown if starred(mark.kind) => delimiter(mark.kind).to_owned(),
        Mode::Markdown => format!(
            "{SCOPE_OPEN}{OPAQUE_OPEN}{}{OPAQUE_CLOSE}",
            delimiter(mark.kind)
        ),
    }
}

fn closing(mark: &MarkdownMark, mode: Mode) -> String {
    match mode {
        Mode::Underscore => underscores(mark.kind).to_owned(),
        Mode::Markdown if starred(mark.kind) => delimiter(mark.kind).to_owned(),
        Mode::Markdown => {
            let written = if mark.kind == MarkKind::Link {
                let attribute = |key: &str| {
                    escape_markers(
                        mark.attrs
                            .as_object()
                            .and_then(|attrs| attrs.get(key))
                            .map(js_value_string)
                            .unwrap_or_default(),
                    )
                };
                let (href, title) = (attribute("href"), attribute("title"));
                if title.is_empty() {
                    format!("]({href})")
                } else {
                    format!("]({href} \"{title}\")")
                }
            } else {
                delimiter(mark.kind).to_owned()
            };
            format!("{OPAQUE_OPEN}{written}{OPAQUE_CLOSE}{SCOPE_CLOSE}")
        }
    }
}

fn marks_after(pieces: &[Piece], index: usize) -> Option<&[MarkdownMark]> {
    pieces.get(index + 1).map(|piece| match piece {
        Piece::Text { marks, .. } => marks.as_slice(),
        Piece::Node { .. } => &[],
    })
}

fn by_kind(marks: &[MarkdownMark]) -> Vec<MarkdownMark> {
    let mut current = Vec::with_capacity(marks.len());
    for mark in marks {
        set_active(&mut current, mark.clone());
    }
    current
}

fn marks_to_open(
    active: &[MarkdownMark],
    current: &[MarkdownMark],
    next: Option<&[MarkdownMark]>,
) -> Vec<MarkdownMark> {
    let to_open: Vec<MarkdownMark> = current
        .iter()
        .filter(|mark| active_mark(active, mark.kind).is_none_or(|open| open != *mark))
        .cloned()
        .collect();
    if to_open.len() <= 1 {
        return to_open;
    }
    let inner_first =
        |left: &MarkdownMark, right: &MarkdownMark| right.kind.rank().cmp(&left.kind.rank());
    let (mut ending, mut continuing): (Vec<_>, Vec<_>) = to_open
        .into_iter()
        .partition(|mark| !next.is_some_and(|next| contains_same_mark(next, mark)));
    ending.sort_by(inner_first);
    continuing.sort_by(inner_first);
    ending.extend(continuing);
    ending
}

fn marks_to_close_at_end(
    active: &[MarkdownMark],
    current: &[MarkdownMark],
    next: Option<&[MarkdownMark]>,
) -> Vec<MarkKind> {
    if let Some(next) = next.filter(|next| !next.is_empty()) {
        if next.len() == current.len() && next.iter().all(|mark| contains_same_mark(current, mark))
        {
            return Vec::new();
        }
        return active
            .iter()
            .rev()
            .filter(|mark| !contains_same_mark(next, mark))
            .map(|mark| mark.kind)
            .collect();
    }
    active.iter().rev().map(|mark| mark.kind).collect()
}

struct Writer<'p> {
    pieces: &'p [Piece],
    result: Vec<String>,
    tails: Vec<OnceCell<String>>,
    active: Vec<MarkdownMark>,
    modes: BTreeMap<MarkKind, Mode>,
    bold_opened_with_italic: bool,
    ends: RefCell<Vec<(usize, usize, MarkdownMark)>>,
}

impl Writer<'_> {
    fn mode(&self, kind: MarkKind) -> Mode {
        self.modes.get(&kind).copied().unwrap_or(Mode::Markdown)
    }

    fn push(&mut self, text: String) {
        self.result.push(text);
        self.tails.push(OnceCell::new());
    }

    fn close_before_trailing_whitespace(&mut self, closings: &str) {
        let Some(last) = self.result.last_mut() else {
            return;
        };
        let written = {
            let (body, spaces) = split_trailing_js_whitespace(last);
            format!("{body}{closings}{spaces}")
        };
        *last = written;
        if let Some(tail) = self.tails.last_mut() {
            *tail = OnceCell::new();
        }
    }

    fn written_end(&self) -> String {
        let mut tails = Vec::new();
        let mut length = 0usize;
        for at in (0..self.result.len()).rev() {
            if length >= 64 {
                break;
            }
            let tail = self.tails[at].get_or_init(|| {
                let written = resolved(&self.result[at]);
                let start = written
                    .char_indices()
                    .rev()
                    .nth(255)
                    .map_or(0, |(start, _)| start);
                written[start..].to_owned()
            });
            length += tail.chars().count();
            tails.push(tail.as_str());
        }
        tails.into_iter().rev().collect()
    }

    fn end_of(&self, index: usize, mark: &MarkdownMark) -> usize {
        let mut ends = self.ends.borrow_mut();
        if let Some(&(_, end, _)) = ends.iter().find(|(from, end, known)| {
            known.kind == mark.kind && *from <= index && index <= *end && known == mark
        }) {
            return end;
        }
        let mut end = index;
        while let Some(Piece::Text { marks, .. }) = self.pieces.get(end + 1) {
            if !contains_same_mark(marks, mark) {
                break;
            }
            end += 1;
        }
        ends.retain(|(_, _, known)| known.kind != mark.kind);
        ends.push((index, end, mark.clone()));
        end
    }

    fn loose_after_run(&self, end: usize) -> bool {
        let Piece::Text { text, marks } = &self.pieces[end] else {
            unreachable!("a run ends with text");
        };
        if text.chars().next_back().is_some_and(is_js_whitespace) {
            return true;
        }
        let Some(after) = self.pieces.get(end + 1) else {
            return true;
        };
        let Piece::Text {
            text: after_text,
            marks: after_marks,
        } = after
        else {
            return matches!(
                after,
                Piece::Node {
                    hard_break: true,
                    ..
                }
            );
        };
        let cut = after_text
            .char_indices()
            .nth(256)
            .map_or(after_text.len(), |(cut, _)| cut);
        let head = resolved(&after_text[..cut]);
        if head.chars().next().is_some_and(is_js_whitespace) {
            return true;
        }
        let mut opens = after_marks
            .iter()
            .filter(|mark| !contains_same_mark(marks, mark))
            .peekable();
        if opens.peek().is_some() {
            return !opens.any(|mark| picky(mark.kind));
        }
        loose_after(&head)
    }

    fn nest_picky_inside(
        &self,
        index: usize,
        to_open: Vec<MarkdownMark>,
        before: &dyn Fn() -> bool,
    ) -> Vec<MarkdownMark> {
        let order: Vec<&MarkdownMark> = to_open.iter().rev().collect();
        let tight = order.iter().enumerate().any(|(at, mark)| {
            if !picky(mark.kind) {
                return false;
            }
            let inside: Vec<&MarkdownMark> = order[at + 1..]
                .iter()
                .copied()
                .filter(|other| !picky(other.kind))
                .collect();
            if inside.is_empty() {
                return false;
            }
            if at == 0 && !before() {
                return true;
            }
            let end = self.end_of(index, mark);
            if !inside.iter().any(|other| self.end_of(index, other) == end) {
                return false;
            }
            if self
                .active
                .iter()
                .chain(order[..at].iter().copied())
                .any(|other| self.end_of(index, other) == end)
            {
                return mark.kind == MarkKind::Italic
                    && self.bold_opened_with_italic
                    && active_mark(&self.active, MarkKind::Bold)
                        .is_some_and(|bold| self.end_of(index, bold) == end);
            }
            !self.loose_after_run(end)
        });
        if !tight {
            return to_open;
        }
        let mut nested: Vec<MarkdownMark> = order
            .iter()
            .filter(|mark| !picky(mark.kind))
            .chain(order.iter().filter(|mark| picky(mark.kind)))
            .map(|mark| (*mark).clone())
            .collect();
        nested.reverse();
        nested
    }

    fn reopens_outside(&self, index: usize, to_open: &[MarkdownMark]) -> Vec<MarkKind> {
        let opening: Vec<&MarkdownMark> = to_open.iter().filter(|mark| !picky(mark.kind)).collect();
        if opening.is_empty()
            || self
                .result
                .last()
                .is_none_or(|last| last.chars().all(is_js_whitespace))
        {
            return Vec::new();
        }
        let at = self.active.iter().enumerate().position(|(at, mark)| {
            if !picky(mark.kind) {
                return false;
            }
            let end = self.end_of(index, mark);
            if !opening.iter().any(|other| self.end_of(index, other) == end) {
                return false;
            }
            if self.active[..at]
                .iter()
                .any(|other| self.end_of(index, other) == end)
            {
                return false;
            }
            !self.loose_after_run(end)
        });
        at.map_or_else(Vec::new, |at| {
            self.active[at..]
                .iter()
                .rev()
                .map(|mark| mark.kind)
                .collect()
        })
    }

    fn closes_with(&self, closing: &[MarkKind]) -> Vec<MarkKind> {
        let order: Vec<MarkKind> = self.active.iter().map(|mark| mark.kind).collect();
        let position = |kind: &MarkKind| order.iter().position(|active| active == kind);
        let Some(from) = closing.iter().filter_map(position).min() else {
            return Vec::new();
        };
        let inner = &order[from..];
        let keeps = inner.iter().any(|kind| !closing.contains(kind));
        let mut closes = if keeps && inner.iter().any(|kind| !starred(*kind)) {
            inner.to_vec()
        } else {
            closing.to_vec()
        };
        closes.sort_by_key(|kind| std::cmp::Reverse(position(kind)));
        closes
    }

    fn note_run(&mut self, opened: &[MarkdownMark]) {
        let Some(at) = opened.iter().position(|mark| mark.kind == MarkKind::Bold) else {
            return;
        };
        self.bold_opened_with_italic = self.modes.get(&MarkKind::Bold) == Some(&Mode::Markdown)
            && at
                .checked_sub(1)
                .is_some_and(|before| opened[before].kind == MarkKind::Italic);
    }

    fn close(&mut self, kind: MarkKind, current: &[MarkdownMark], active_first: bool) -> String {
        let (first, second) = if active_first {
            (self.active.as_slice(), current)
        } else {
            (current, self.active.as_slice())
        };
        let written = active_mark(first, kind)
            .or_else(|| active_mark(second, kind))
            .map(|mark| closing(mark, self.mode(kind)))
            .unwrap_or_default();
        remove_active(&mut self.active, kind);
        self.modes.remove(&kind);
        written
    }
}

/// Writes inline content with dohc's own mark delimiters, as the TypeScript
/// writer's `DohcMarkdownManager` does, so both writers choose the same ones.
pub(super) fn write_inline(pieces: &[Piece]) -> ProjectionResult<String> {
    let mut writer = Writer {
        pieces,
        result: Vec::with_capacity(pieces.len()),
        tails: Vec::with_capacity(pieces.len()),
        active: Vec::new(),
        modes: BTreeMap::new(),
        bold_opened_with_italic: false,
        ends: RefCell::new(Vec::new()),
    };
    let mut loose_edge = Some(true);
    let mut reopened: Vec<MarkKind> = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        let next = marks_after(pieces, index);
        let (source, marks) = match piece {
            Piece::Node { rendered, .. } => {
                let mut written = String::new();
                for mark in &writer.active {
                    written.push_str(&closing(mark, writer.mode(mark.kind)));
                }
                writer.active.clear();
                writer.modes.clear();
                written.push(OPAQUE_OPEN);
                written.push_str(rendered);
                written.push(OPAQUE_CLOSE);
                writer.push(written);
                loose_edge = Some(true);
                continue;
            }
            Piece::Text { text, marks } => (text, marks),
        };
        let reopening = std::mem::take(&mut reopened);
        if writer.active.is_empty() && marks.is_empty() {
            loose_edge = ends_with_escape(source).then_some(true);
            writer.push(source.clone());
            continue;
        }
        let current = by_kind(marks);
        let to_close: Vec<MarkKind> = current
            .iter()
            .filter(|mark| next.is_none_or(|next| !contains_same_mark(next, mark)))
            .map(|mark| mark.kind)
            .collect();
        let blank = source.chars().all(is_js_whitespace);
        let mut reopens_here = false;
        if !blank {
            let to_open = marks_to_open(&writer.active, &current, next);
            let mut closings = String::new();
            for kind in writer.reopens_outside(index, &to_open) {
                closings.push_str(&writer.close(kind, &current, true));
            }
            if !closings.is_empty() {
                writer.close_before_trailing_whitespace(&closings);
                reopens_here = true;
            }
        }
        let to_open = if blank {
            Vec::new()
        } else {
            let starts_with_space = source.chars().next().is_some_and(is_js_whitespace);
            let edge = loose_edge;
            let writer = &writer;
            let before = || {
                reopens_here
                    || starts_with_space
                    || edge.unwrap_or_else(|| loose_before(&writer.written_end()))
            };
            writer.nest_picky_inside(
                index,
                marks_to_open(&writer.active, &current, next),
                &before,
            )
        };
        let active_closing: Vec<MarkKind> = to_close
            .iter()
            .copied()
            .filter(|kind| active_mark(&writer.active, *kind).is_some())
            .collect();
        let crossed = !active_closing.is_empty() && !to_open.is_empty();

        let mut body = source.as_str();
        let mut middle_trailing = "";
        if !to_close.is_empty() && !crossed {
            (body, middle_trailing) = split_trailing_js_whitespace(body);
        }
        let mut text = body.to_owned();
        let mut closed = false;
        if !crossed && !active_closing.is_empty() {
            closed = true;
            for kind in writer.closes_with(&active_closing) {
                text.push_str(&writer.close(kind, &current, false));
            }
        }
        let mut leading = String::new();
        if !to_open.is_empty() {
            let (spaces, rest) = split_leading_js_whitespace(&text);
            leading = spaces.to_owned();
            text = rest.to_owned();
        }
        let mut openings = String::new();
        for (at, mark) in to_open.iter().enumerate() {
            let asterisked = at + 1 == to_open.len()
                && reopening.contains(&mark.kind)
                && leading.is_empty()
                && writer.written_end().ends_with('*');
            let mode = if asterisked {
                Mode::Underscore
            } else {
                Mode::Markdown
            };
            openings.insert_str(0, &opening(mark, mode));
            writer.modes.insert(mark.kind, mode);
        }
        writer.note_run(&to_open);
        if !crossed {
            for mark in to_open.iter().rev() {
                set_active(&mut writer.active, mark.clone());
            }
        }
        let mut text = leading + &openings + &text;

        let close_at_end: Vec<MarkKind> = if crossed {
            for mark in &to_open {
                if starred(mark.kind)
                    && next.is_some_and(|next| next.iter().any(|other| other.kind == mark.kind))
                    && !reopened.contains(&mark.kind)
                {
                    reopened.push(mark.kind);
                }
            }
            to_open
                .iter()
                .map(|mark| mark.kind)
                .chain(writer.closes_with(&active_closing))
                .collect()
        } else {
            writer.closes_with(&marks_to_close_at_end(&writer.active, &current, next))
        };
        let mut trailing = String::new();
        if !close_at_end.is_empty() {
            let (body, spaces) = split_trailing_js_whitespace(&text);
            let kept = body.len();
            trailing = spaces.to_owned();
            text.truncate(kept);
        }
        for kind in close_at_end {
            text.push_str(&writer.close(kind, &current, true));
            closed = true;
        }
        loose_edge = (closed && trailing.is_empty() && middle_trailing.is_empty()).then_some(true);
        text.push_str(&trailing);
        text.push_str(middle_trailing);
        writer.push(text);
    }
    let mut joined = ProjectionBuffer::new();
    for text in &writer.result {
        joined.push_str(text)?;
    }
    write_held_characters(joined.into_string())
}
