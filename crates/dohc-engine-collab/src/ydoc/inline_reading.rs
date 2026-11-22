//! The editor reads a block's inline Markdown with marked, so this reader
//! follows marked's own lexer, in UTF-16 units as marked counts. It reads code
//! spans, links, images, emphasis and strike. Anything else, and anything it
//! cannot follow exactly, leaves the block's text as written.

use super::*;

const LINK_REL: &str = "noopener noreferrer nofollow";

pub(super) enum InlinePiece {
    Text(TextRun),
    Image(BTreeMap<String, Value>),
}

struct Unsure;

type Read<T> = Result<T, Unsure>;

/// The block's inline content as the editor reads `text`, when this reader
/// follows that reading and the projector writes it back as `text`.
pub(super) fn read_inline(text: &str, paragraph: bool) -> Option<Vec<InlinePiece>> {
    if !text
        .bytes()
        .any(|byte| matches!(byte, b'*' | b'_' | b'`' | b'~' | b'[' | b'!' | b'&'))
        || unsure_text(text)
        || (!paragraph && text.trim() != text)
    {
        return None;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut pieces = Vec::new();
    let mut work = units.len().saturating_mul(SCAN_WORK_PER_UNIT);
    lex(&units, &[], false, &mut work, &mut pieces).ok()?;
    let mut pieces = merged(pieces);
    if pieces.iter().any(unsure_piece) {
        return None;
    }
    for piece in &mut pieces {
        if let InlinePiece::Text(run) = piece {
            if !run.marks.iter().any(|mark| mark.kind == MarkKind::Code) {
                run.text = replaced_references(&run.text, true);
            }
        }
    }
    let read: Vec<MarkdownNode> = pieces
        .iter()
        .map(|piece| match piece {
            InlinePiece::Text(run) => MarkdownNode::Text(vec![run.clone()]),
            InlinePiece::Image(attrs) => MarkdownNode::Element {
                tag: "image".into(),
                attrs: attrs.clone(),
                children: Vec::new(),
            },
        })
        .collect();
    let written = render_inline(&read, false, paragraph, false).ok()?;
    (written == text).then_some(pieces)
}

const SCAN_WORK_PER_UNIT: usize = 32;

// The editor sets character references aside before marked reads the text,
// inside code spans too, which changes where emphasis closes.
fn unsure_text(text: &str) -> bool {
    text.contains(" \n")
        || text.ends_with(' ')
        || text.contains("&#")
        || text.to_ascii_lowercase().contains("&amp;#")
        || text.chars().any(|character| {
            matches!(character, '\\' | '\r' | '\u{a0}')
                || (character.is_control() && character != '\n')
                || ('\u{e000}'..='\u{f8ff}').contains(&character)
        })
}

// These open syntax this reader doesn't follow, except inside a code span,
// which holds its text as written.
fn unsure_syntax(text: &str) -> bool {
    text.contains("==")
        || text.contains("++")
        || text.contains("[[")
        || text.contains(['<', '>', '&', '$', '{'])
}

// The projector writes `&`, `<` and `>` in text as these references, so a
// text holding them reads back as written.
const WRITTEN_REFERENCES: [(&str, char); 3] = [("&amp;", '&'), ("&lt;", '<'), ("&gt;", '>')];

fn replaced_references(text: &str, decode: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match WRITTEN_REFERENCES
            .iter()
            .find(|(reference, _)| rest.starts_with(reference))
        {
            Some((reference, character)) => {
                if decode {
                    out.push(*character);
                }
                rest = &rest[reference.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn unsure_piece(piece: &InlinePiece) -> bool {
    match piece {
        InlinePiece::Text(run) => {
            (!run.marks.iter().any(|mark| mark.kind == MarkKind::Code)
                && unsure_syntax(&replaced_references(&run.text, false)))
                || run.marks.iter().any(|mark| {
                    mark.kind == MarkKind::Link
                        && ["href", "title"]
                            .iter()
                            .any(|key| mark.attrs[key].as_str().is_some_and(unsure_syntax))
                })
        }
        InlinePiece::Image(attrs) => attrs
            .values()
            .any(|value| value.as_str().is_some_and(unsure_syntax)),
    }
}

fn merged(pieces: Vec<InlinePiece>) -> Vec<InlinePiece> {
    let mut out: Vec<InlinePiece> = Vec::new();
    for piece in pieces {
        if let (Some(InlinePiece::Text(last)), InlinePiece::Text(run)) = (out.last_mut(), &piece) {
            if last.marks == run.marks {
                last.text.push_str(&run.text);
                continue;
            }
        }
        if matches!(&piece, InlinePiece::Text(run) if run.text.is_empty()) {
            continue;
        }
        out.push(piece);
    }
    out
}

fn string(units: &[u16]) -> Read<String> {
    String::from_utf16(units).map_err(|_| Unsure)
}

fn ascii(unit: u16) -> Option<u8> {
    u8::try_from(unit).ok().filter(u8::is_ascii)
}

fn is_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20)
}

fn is_punct(byte: u8) -> bool {
    byte.is_ascii_punctuation()
}

/// The class of a character next to a delimiter run, as marked's Unicode
/// classes read it. A character outside ASCII is beyond this reader.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Space,
    Punct(u8),
    Other(u8),
}

fn class(unit: u16) -> Read<Class> {
    let byte = ascii(unit).ok_or(Unsure)?;
    Ok(if is_space(unit) {
        Class::Space
    } else if is_punct(byte) {
        Class::Punct(byte)
    } else {
        Class::Other(byte)
    })
}

fn add_mark(marks: &[MarkdownMark], mark: MarkdownMark) -> Read<Vec<MarkdownMark>> {
    if marks.iter().any(|held| held.kind == mark.kind) {
        return Err(Unsure);
    }
    let mut marks = marks.to_vec();
    marks.push(mark);
    marks.sort_by_key(|mark| mark.kind.rank());
    Ok(marks)
}

fn plain(kind: MarkKind) -> MarkdownMark {
    MarkdownMark {
        kind,
        attrs: Value::Object(Default::default()),
    }
}

// marked masks links, code spans and tags before it looks for closing
// emphasis, so no delimiter inside one closes a run outside it.
fn masked(src: &[u16]) -> Read<Vec<u16>> {
    let last_close = src.iter().rposition(|unit| *unit == u16::from(b']'));
    let mut out = src.to_vec();
    let mut at = 0;
    while at < src.len() {
        let end = if src[at] == u16::from(b'[') {
            masked_link(src, at)?
        } else if src[at] == u16::from(b'`') && (at == 0 || src[at - 1] != u16::from(b'`')) {
            let end = masked_code(src, at);
            if end.is_some_and(|end| {
                last_close.is_some_and(|close| close >= end) && opens_label(&src[at..end])
            }) {
                return Err(Unsure);
            }
            end
        } else if src[at] == u16::from(b'<') {
            masked_tag(src, at)
        } else {
            None
        };
        if let Some(end) = end {
            out[at] = u16::from(b'[');
            for unit in &mut out[at + 1..end - 1] {
                *unit = u16::from(b'a');
            }
            out[end - 1] = u16::from(b']');
            at = end;
        } else {
            at += 1;
        }
    }
    Ok(out)
}

fn masked_link(src: &[u16], at: usize) -> Read<Option<usize>> {
    let mut index = at + 1;
    while index < src.len() && src[index] != u16::from(b']') {
        if src[index] == u16::from(b'[') {
            return Err(Unsure);
        }
        if src[index] == u16::from(b'`') {
            let Some(end) = masked_code(src, index) else {
                return Ok(None);
            };
            index = end;
            continue;
        }
        index += 1;
    }
    if src.get(index + 1) != Some(&u16::from(b'(')) {
        return Ok(None);
    }
    let mut index = index + 2;
    let mut depth = 0;
    while let Some(&unit) = src.get(index) {
        match ascii(unit) {
            Some(b'\\') => return Err(Unsure),
            Some(b'(') if depth == 0 => depth = 1,
            Some(b'(') => return Ok(None),
            Some(b')') if depth == 1 => depth = 0,
            Some(b')') => return Ok(Some(index + 1)),
            _ => {}
        }
        index += 1;
    }
    Ok(None)
}

// marked masks anything from a `<` not followed by a space to the next `>`
// with no `<` between, even where code spans hold both.
fn masked_tag(src: &[u16], at: usize) -> Option<usize> {
    if src.get(at + 1) == Some(&u16::from(b' ')) {
        return None;
    }
    let close = src[at + 1..]
        .iter()
        .position(|unit| matches!(ascii(*unit), Some(b'<' | b'>')))?;
    (src[at + 1 + close] == u16::from(b'>')).then_some(at + close + 2)
}

fn masked_code(src: &[u16], at: usize) -> Option<usize> {
    let run = run_of(src, at, u16::from(b'`'));
    let mut index = at + run;
    let content = index;
    while index < src.len() && src[index] != u16::from(b'`') {
        index += 1;
    }
    (index > content && run_of(src, index, u16::from(b'`')) == run).then_some(index + run)
}

// marked masks a reference link before code spans, so a label that opens
// inside a code span and closes after it can end the span early.
fn opens_label(span: &[u16]) -> bool {
    let mut open = 0usize;
    for unit in span {
        match ascii(*unit) {
            Some(b'[') => open += 1,
            Some(b']') => open = open.saturating_sub(1),
            _ => {}
        }
    }
    open > 0
}

fn run_of(src: &[u16], at: usize, unit: u16) -> usize {
    src[at..].iter().take_while(|held| **held == unit).count()
}

fn lex(
    src: &[u16],
    marks: &[MarkdownMark],
    in_link: bool,
    work: &mut usize,
    out: &mut Vec<InlinePiece>,
) -> Read<()> {
    let mask = masked(src)?;
    let mut at = 0;
    let mut previous: Option<u16> = None;
    let mut after_text = false;
    while at < src.len() {
        if !after_text {
            previous = None;
        }
        after_text = false;
        let rest = &src[at..];
        let first = ascii(rest[0]);
        if matches!(first, Some(b'['))
            || (first == Some(b'!') && rest.get(1) == Some(&u16::from(b'[')))
        {
            at += link(rest, marks, in_link, work, out)?;
            continue;
        }
        if matches!(first, Some(b'*' | b'_')) {
            if let Some((length, strong)) = em_strong(rest, &mask[at..], previous, work)? {
                let (open, mark) = if strong {
                    (2, MarkKind::Bold)
                } else {
                    (1, MarkKind::Italic)
                };
                let inner = &rest[open..length - open];
                lex(inner, &add_mark(marks, plain(mark))?, in_link, work, out)?;
                at += length;
                continue;
            }
        }
        if first == Some(b'`') {
            if let Some(length) = code_span(rest, marks, work, out)? {
                at += length;
                continue;
            }
        }
        if first == Some(b'~') {
            if let Some(length) = del(rest, &mask[at..], previous, work)? {
                let open = run_of(rest, 0, u16::from(b'~'));
                let inner = &rest[open..length - open];
                lex(
                    inner,
                    &add_mark(marks, plain(MarkKind::Strike))?,
                    in_link,
                    work,
                    out,
                )?;
                at += length;
                continue;
            }
        }
        if !in_link && starts_url(rest, work)? {
            return Err(Unsure);
        }
        let length = inline_text(rest, work)?;
        let text = &rest[..length];
        if text.last() != Some(&u16::from(b'_')) {
            previous = text.last().copied();
        }
        after_text = true;
        out.push(InlinePiece::Text(TextRun {
            text: string(text)?,
            marks: marks.to_vec(),
        }));
        at += length;
    }
    Ok(())
}

fn email_unit(unit: u16) -> bool {
    ascii(unit)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?_`{|}~-".contains(&byte))
}

fn email_ahead(src: &[u16], work: &mut usize) -> Read<bool> {
    let run = src.iter().take_while(|unit| email_unit(**unit)).count();
    spend(work, run)?;
    Ok(run > 0 && src.get(run) == Some(&u16::from(b'@')))
}

fn lower(src: &[u16], at: usize, word: &str) -> bool {
    word.bytes().enumerate().all(|(index, byte)| {
        src.get(at + index)
            .and_then(|unit| ascii(*unit))
            .is_some_and(|held| held.to_ascii_lowercase() == byte)
    })
}

fn protocol_at(src: &[u16], at: usize) -> bool {
    ["http://", "https://", "ftp://"]
        .iter()
        .any(|word| lower(src, at, word))
}

fn starts_url(src: &[u16], work: &mut usize) -> Read<bool> {
    if protocol_at(src, 0) || lower(src, 0, "www.") {
        return Ok(true);
    }
    let local = src
        .iter()
        .take_while(|unit| {
            ascii(**unit)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
        })
        .count();
    spend(work, local)?;
    Ok(local > 0 && src.get(local) == Some(&u16::from(b'@')))
}

// marked's GFM text rule: one character, or a run of backticks and tildes,
// then up to the next character that can open a token.
fn inline_text(src: &[u16], work: &mut usize) -> Read<usize> {
    let first = if matches!(ascii(src[0]), Some(b'`' | b'~')) {
        src.iter()
            .take_while(|unit| matches!(ascii(**unit), Some(b'`' | b'~')))
            .count()
    } else if (0xd800..0xdc00).contains(&src[0]) && src.len() > 1 {
        2
    } else {
        1
    };
    if email_ahead(&src[first..], work)? {
        return Ok(first);
    }
    let mut at = first;
    while at < src.len() {
        if matches!(
            ascii(src[at]),
            Some(b'\\' | b'<' | b'!' | b'[' | b'`' | b'*' | b'~' | b'_')
        ) || protocol_at(src, at)
            || lower(src, at, "www.")
        {
            return Ok(at);
        }
        if !email_unit(src[at]) && email_ahead(&src[at + 1..], work)? {
            return Ok(at + 1);
        }
        at += 1;
    }
    Ok(at)
}

fn em_strong(
    src: &[u16],
    mask: &[u16],
    previous: Option<u16>,
    work: &mut usize,
) -> Read<Option<(usize, bool)>> {
    let delimiter = src[0];
    let star = delimiter == u16::from(b'*');
    let run = run_of(src, 0, delimiter);
    let Some(&after) = src.get(run) else {
        return Ok(None);
    };
    let after_class = class(after)?;
    let after_punct = match after_class {
        Class::Space => return Ok(None),
        Class::Punct(b'~') => false,
        Class::Punct(_) => true,
        Class::Other(_) => false,
    };
    let previous_class = previous.map(class).transpose()?;
    if !star
        && !after_punct
        && previous_class.is_some_and(
            |class| matches!(class, Class::Other(byte) if byte.is_ascii_alphanumeric()),
        )
    {
        return Ok(None);
    }
    if after_punct
        && previous_class.is_some_and(|class| match class {
            Class::Space => false,
            Class::Punct(byte) => byte == b'*' || byte == b'_',
            Class::Other(_) => true,
        })
    {
        return Ok(None);
    }
    let scan = &mask[run..];
    let mut left = run as isize;
    let mut delayed = 0isize;
    let mut from = 0;
    while let Some(found) = right_delimiter(scan, from, delimiter, star)? {
        spend(work, found.end - from)?;
        from = found.end;
        let Some(group) = found.group else { continue };
        let length = found.run as isize;
        if group == 3 || group == 4 {
            left += length;
            continue;
        }
        if (group == 5 || group == 6) && run % 3 != 0 && (run + found.run) % 3 == 0 {
            delayed += length;
            continue;
        }
        left -= length;
        if left > 0 {
            continue;
        }
        let closing = length.min(length + left + delayed) as usize;
        let total = run + found.index + 1 + closing;
        return Ok(Some((total, run.min(closing) % 2 == 0)));
    }
    spend(work, scan.len() - from)?;
    Ok(None)
}

fn spend(work: &mut usize, units: usize) -> Read<()> {
    *work = work.checked_sub(units).ok_or(Unsure)?;
    Ok(())
}

struct Delimiter {
    index: usize,
    end: usize,
    group: Option<u8>,
    run: usize,
}

// marked's emStrongRDelimAst (GFM) and emStrongRDelimUnd, tried at each place
// in order, the way the global regex finds its leftmost match.
fn right_delimiter(t: &[u16], from: usize, delimiter: u16, star: bool) -> Read<Option<Delimiter>> {
    let other = if star {
        u16::from(b'_')
    } else {
        u16::from(b'*')
    };
    for at in from..t.len() {
        if at == 0 {
            if let Some(end) = skip_pair(t, delimiter, other) {
                return Ok(Some(Delimiter {
                    index: 0,
                    end,
                    group: None,
                    run: 0,
                }));
            }
        }
        if t[at] != delimiter {
            let stop = t[at..]
                .iter()
                .position(|unit| *unit == delimiter)
                .map_or(t.len(), |offset| at + offset);
            let last = if stop >= 2
                && (0xdc00..0xe000).contains(&t[stop - 1])
                && (0xd800..0xdc00).contains(&t[stop - 2])
            {
                2
            } else {
                1
            };
            if stop > at + last {
                return Ok(Some(Delimiter {
                    index: at,
                    end: stop - last,
                    group: None,
                    run: 0,
                }));
            }
            let run = run_of(t, at + 1, delimiter);
            if run == 0 {
                continue;
            }
            let lead = class(t[at])?;
            let follow = t.get(at + 1 + run).map(|unit| class(*unit)).transpose()?;
            let punct = |class: Class| match class {
                Class::Punct(byte) => !(star && byte == b'~'),
                _ => false,
            };
            let punct_space = |class: Class| class == Class::Space || punct(class);
            let not_punct_space = |class: Class| !punct_space(class);
            let end = at + 1 + run;
            let group = if punct(lead) && follow.is_none_or(|class| class == Class::Space) {
                Some(1)
            } else if not_punct_space(lead) && follow.is_none_or(punct_space) {
                Some(2)
            } else if punct_space(lead) && follow.is_some_and(not_punct_space) {
                Some(3)
            } else if lead == Class::Space && follow.is_some_and(punct) {
                Some(4)
            } else if punct(lead) && follow.is_some_and(punct) {
                Some(5)
            } else if star && not_punct_space(lead) && follow.is_some_and(not_punct_space) {
                Some(6)
            } else {
                None
            };
            if let Some(group) = group {
                return Ok(Some(Delimiter {
                    index: at,
                    end,
                    group: Some(group),
                    run,
                }));
            }
        }
    }
    Ok(None)
}

// The first alternative of marked's right-delimiter rules, which steps over
// `__…*…__` (or `**…_…**`) from the start.
fn skip_pair(t: &[u16], delimiter: u16, other: u16) -> Option<usize> {
    let next = |from: usize| {
        t[from..]
            .iter()
            .position(|unit| *unit == delimiter || *unit == other)
            .map(|offset| from + offset)
    };
    let first = next(0)?;
    if t.get(first) != Some(&other) || t.get(first + 1) != Some(&other) {
        return None;
    }
    let middle = next(first + 2)?;
    if t[middle] != delimiter {
        return None;
    }
    let last = next(middle + 1)?;
    (t.get(last) == Some(&other) && t.get(last + 1) == Some(&other)).then_some(last)
}

fn del(src: &[u16], mask: &[u16], previous: Option<u16>, work: &mut usize) -> Read<Option<usize>> {
    let tilde = u16::from(b'~');
    let run = run_of(src, 0, tilde);
    if run > 2 {
        return Ok(None);
    }
    let Some(&after) = src.get(run) else {
        return Ok(None);
    };
    let after_punct = match class(after)? {
        Class::Space => return Ok(None),
        Class::Punct(_) => true,
        Class::Other(_) => false,
    };
    if after_punct
        && previous
            .map(class)
            .transpose()?
            .is_some_and(|class| match class {
                Class::Space => false,
                Class::Punct(byte) => byte == b'*' || byte == b'_',
                Class::Other(_) => true,
            })
    {
        return Ok(None);
    }
    let t = &mask[run..];
    let mut left = run as isize;
    let mut at = 0;
    if t.first().is_some_and(|unit| *unit != tilde) {
        let stop = t.iter().position(|unit| *unit == tilde).unwrap_or(t.len());
        if stop >= 2 {
            at = stop - 1;
        }
    }
    while at < t.len() {
        if t[at] == tilde {
            at += 1;
            continue;
        }
        let available = run_of(t, at + 1, tilde);
        let mut matched = None;
        for length in [2usize, 1] {
            if available < length {
                continue;
            }
            let lead = class(t[at])?;
            let follow_unit = t.get(at + 1 + length).copied();
            let follow = follow_unit.map(class).transpose()?;
            let no_more = follow_unit != Some(tilde);
            let punct = |class: Class| matches!(class, Class::Punct(byte) if byte != b'~');
            let punct_space =
                |class: Class| class == Class::Space || matches!(class, Class::Punct(_));
            let not_punct_space = |class: Class| matches!(class, Class::Other(_));
            let group = if punct(lead) && follow.is_none_or(|class| class == Class::Space) {
                Some(1)
            } else if not_punct_space(lead) && no_more && follow.is_none_or(punct_space) {
                Some(2)
            } else if punct_space(lead)
                && !matches!(lead, Class::Punct(b'~'))
                && follow.is_some_and(not_punct_space)
            {
                Some(3)
            } else if lead == Class::Space
                && no_more
                && follow.is_some_and(|class| matches!(class, Class::Punct(_)))
            {
                Some(4)
            } else if punct(lead)
                && no_more
                && follow.is_some_and(|class| matches!(class, Class::Punct(_)))
            {
                Some(5)
            } else if not_punct_space(lead) && follow.is_some_and(not_punct_space) {
                Some(6)
            } else {
                None
            };
            if let Some(group) = group {
                matched = Some((group, length));
                break;
            }
        }
        let Some((group, length)) = matched else {
            at += 1;
            continue;
        };
        let end = at + 1 + length;
        if length != run {
            at = end;
            continue;
        }
        if group == 3 || group == 4 {
            left += length as isize;
            at = end;
            continue;
        }
        left -= length as isize;
        if left > 0 {
            at = end;
            continue;
        }
        spend(work, at)?;
        return Ok(Some(run + at + 1 + run));
    }
    spend(work, t.len())?;
    Ok(None)
}

fn code_span(
    src: &[u16],
    marks: &[MarkdownMark],
    work: &mut usize,
    out: &mut Vec<InlinePiece>,
) -> Read<Option<usize>> {
    let tick = u16::from(b'`');
    let run = run_of(src, 0, tick);
    let mut at = run;
    while at < src.len() {
        if src[at] == tick {
            let closing = run_of(src, at, tick);
            if closing == run && at > run {
                let mut value = string(&src[run..at])?.replace('\n', " ");
                if value.starts_with(' ')
                    && value.ends_with(' ')
                    && value.bytes().any(|byte| byte != b' ')
                {
                    value = value[1..value.len() - 1].to_owned();
                }
                out.push(InlinePiece::Text(TextRun {
                    text: value,
                    marks: add_mark(marks, plain(MarkKind::Code))?,
                }));
                spend(work, at)?;
                return Ok(Some(at + run));
            }
            at += closing;
        } else {
            at += 1;
        }
    }
    spend(work, src.len())?;
    Ok(None)
}

// An inline link or image in the plain form `[label](destination "title")`.
// Any other `[` is beyond this reader.
fn link(
    src: &[u16],
    marks: &[MarkdownMark],
    in_link: bool,
    work: &mut usize,
    out: &mut Vec<InlinePiece>,
) -> Read<usize> {
    let image = src[0] == u16::from(b'!');
    let open = usize::from(image);
    let label_end = label_end(src, open + 1)?;
    let label = &src[open + 1..label_end];
    if label.is_empty()
        || label
            .iter()
            .any(|unit| matches!(ascii(*unit), Some(b'[' | b'\n')))
        || src.get(label_end + 1) != Some(&u16::from(b'('))
        || in_link
    {
        return Err(Unsure);
    }
    let destination_start = label_end + 2;
    let mut at = destination_start;
    while src.get(at).is_some_and(|unit| {
        ascii(*unit).is_some_and(|byte| byte.is_ascii_graphic() && !b"()<>\"'\\".contains(&byte))
    }) {
        at += 1;
    }
    let destination = string(&src[destination_start..at])?;
    if destination.is_empty() || !safe_destination(&destination, image) {
        return Err(Unsure);
    }
    let mut title = None;
    if src.get(at) == Some(&u16::from(b' ')) && src.get(at + 1) == Some(&u16::from(b'"')) {
        let start = at + 2;
        let close = src[start..]
            .iter()
            .position(|unit| *unit == u16::from(b'"'))
            .map(|offset| start + offset)
            .ok_or(Unsure)?;
        let value = string(&src[start..close])?;
        if value.is_empty() || value.contains('\n') {
            return Err(Unsure);
        }
        title = Some(value);
        at = close + 1;
    }
    if src.get(at) != Some(&u16::from(b')')) {
        return Err(Unsure);
    }
    if image {
        let alt = string(label)?;
        if !marks.is_empty() || alt.chars().any(|character| "*_~!`".contains(character)) {
            return Err(Unsure);
        }
        let mut attrs = BTreeMap::from([
            ("src".to_owned(), Value::String(destination)),
            ("alt".to_owned(), Value::String(alt)),
        ]);
        if let Some(title) = title {
            attrs.insert("title".to_owned(), Value::String(title));
        }
        out.push(InlinePiece::Image(attrs));
    } else {
        let mark = MarkdownMark {
            kind: MarkKind::Link,
            attrs: json!({
                "href": destination,
                "target": "_blank",
                "rel": LINK_REL,
                "class": null,
                "title": title,
            }),
        };
        lex(label, &add_mark(marks, mark)?, true, work, out)?;
    }
    Ok(at + 1)
}

// The end of a link's label under marked's link rule, where a backtick run
// opens a piece that ends at the next backtick run, whatever its length.
fn label_end(src: &[u16], from: usize) -> Read<usize> {
    let tick = u16::from(b'`');
    let mut at = from;
    while let Some(&unit) = src.get(at) {
        if unit == u16::from(b']') {
            return Ok(at);
        }
        if unit == tick {
            let run = run_of(src, at, tick);
            let content = at + run;
            match src[content..].iter().position(|unit| *unit == tick) {
                Some(offset) => at = content + offset + run_of(src, content + offset, tick),
                None if run >= 2 && src.get(content) == Some(&u16::from(b']')) => at = content,
                None => return Err(Unsure),
            }
            continue;
        }
        at += 1;
    }
    Err(Unsure)
}

fn safe_destination(destination: &str, image: bool) -> bool {
    let scheme = destination
        .split_once(':')
        .map(|(scheme, _)| scheme)
        .filter(|scheme| {
            scheme.starts_with(|character: char| character.is_ascii_alphabetic())
                && scheme
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"+.-".contains(&byte))
        });
    match scheme.map(str::to_ascii_lowercase).as_deref() {
        Some("http" | "https") => true,
        Some("mailto") => !image,
        Some(_) => false,
        None => {
            !destination.starts_with('/')
                && !destination.contains("..")
                && !destination.contains('&')
        }
    }
}

/// Writes `pieces` into `element` as the editor's reading holds them: text
/// runs with their marks, and an image between them.
pub(super) fn insert_pieces(
    txn: &mut yrs::TransactionMut<'_>,
    element: &yrs::XmlElementRef,
    pieces: &[InlinePiece],
) {
    use yrs::types::{Attrs, Delta};
    let mut index = 0;
    let mut runs: Vec<Delta<String>> = Vec::new();
    let flush =
        |txn: &mut yrs::TransactionMut<'_>, runs: &mut Vec<Delta<String>>, index: &mut u32| {
            if runs.is_empty() {
                return;
            }
            let text = element.insert(txn, *index, XmlTextPrelim::new(""));
            text.apply_delta(txn, std::mem::take(runs));
            *index += 1;
        };
    for piece in pieces {
        match piece {
            InlinePiece::Text(run) => {
                let attrs: Attrs = run
                    .marks
                    .iter()
                    .map(|mark| (mark_name(mark.kind).into(), json_to_any(&mark.attrs)))
                    .collect();
                runs.push(Delta::Inserted(
                    run.text.clone(),
                    (!attrs.is_empty()).then(|| Box::new(attrs)),
                ));
            }
            InlinePiece::Image(attrs) => {
                flush(txn, &mut runs, &mut index);
                let image = element.insert(txn, index, XmlElementPrelim::empty("image"));
                for (key, value) in attrs {
                    if let Value::String(value) = value {
                        image.insert_attribute(txn, key.as_str(), value.as_str());
                    }
                }
                index += 1;
            }
        }
    }
    flush(txn, &mut runs, &mut index);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn runs_of(node: &Value) -> Vec<Value> {
        if node["type"] == "xmlText" {
            return node["delta"]
                .as_array()
                .expect("delta")
                .iter()
                .map(|run| {
                    let marks = run.get("attrs").cloned().unwrap_or_else(|| json!({}));
                    json!({ "x": run["insert"], "m": marks })
                })
                .collect();
        }
        let mut attrs = node["attrs"].as_object().cloned().unwrap_or_default();
        attrs.retain(|key, value| {
            !value.is_null()
                && !matches!(
                    (key.as_str(), &*value),
                    ("colspan" | "rowspan", Value::Number(_))
                        if value.as_f64() == Some(1.0)
                )
                && !matches!(
                    (key.as_str(), &*value),
                    ("loose" | "checked", Value::Bool(false))
                )
        });
        let mut element = json!({ "t": node["tag"] });
        if !attrs.is_empty() {
            element["a"] = Value::Object(attrs);
        }
        let children: Vec<Value> = node["children"]
            .as_array()
            .expect("children")
            .iter()
            .flat_map(runs_of)
            .collect();
        if !children.is_empty() {
            element["c"] = Value::Array(children);
        }
        vec![element]
    }

    fn normalized(value: &Value) -> Value {
        match value {
            Value::Number(number) => json!(number.as_f64()),
            Value::Array(items) => {
                let mut out: Vec<Value> = Vec::new();
                for item in items.iter().map(normalized) {
                    let marks =
                        |value: &Value| value.get("m").cloned().unwrap_or_else(|| json!({}));
                    if let (Some(last), Some(text)) = (out.last_mut(), item.get("x")) {
                        if last.get("x").is_some() && marks(last) == marks(&item) {
                            let joined = format!(
                                "{}{}",
                                last["x"].as_str().unwrap(),
                                text.as_str().unwrap()
                            );
                            last["x"] = Value::String(joined);
                            continue;
                        }
                    }
                    out.push(item);
                }
                Value::Array(out)
            }
            Value::Object(entries) => Value::Object(
                entries
                    .iter()
                    .filter(|(key, value)| {
                        !(key.as_str() == "m" && value.as_object().is_some_and(|m| m.is_empty()))
                    })
                    .map(|(key, value)| (key.clone(), normalized(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn reads_marks(node: &Value) -> bool {
        node.get("m").is_some()
            || node["t"] == "image"
            || node["c"]
                .as_array()
                .is_some_and(|children| children.iter().any(reads_marks))
    }

    fn same_reading(engine: &Value, editor: &Value, markdown: &str, read: &mut usize) {
        if engine["t"] != editor["t"] {
            return;
        }
        if matches!(engine["t"].as_str(), Some("paragraph" | "heading")) && reads_marks(engine) {
            *read += 1;
            assert_eq!(engine, editor, "{markdown:?}");
            return;
        }
        let (Some(engine), Some(editor)) = (engine["c"].as_array(), editor["c"].as_array()) else {
            return;
        };
        if engine.len() == editor.len() {
            for (engine, editor) in engine.iter().zip(editor) {
                same_reading(engine, editor, markdown, read);
            }
        }
    }

    #[test]
    fn the_engine_reads_inline_markdown_as_the_editor_does() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/readerParity.json"
        );
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(path).expect("generated fixture"))
                .expect("fixture json");
        let cases = fixture["expected"]["cases"].as_array().expect("cases");
        let mut read = 0;
        for case in cases {
            let markdown = case["markdown"].as_str().expect("markdown");
            let doc = Ydoc::wire();
            if doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .is_err()
            {
                continue;
            }
            let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
            let txn = doc.doc.transact();
            let engine: Vec<Value> = body
                .children(&txn)
                .flat_map(|child| runs_of(&xml_json(&txn, child)))
                .collect();
            let engine = json!({ "c": normalized(&Value::Array(engine)) });
            let editor = json!({ "c": normalized(&case["reading"]) });
            same_reading(&engine, &editor, markdown, &mut read);
        }
        assert!(
            read * 4 > cases.len(),
            "the engine read marks in {read} blocks of {} cases",
            cases.len()
        );
    }

    #[test]
    fn an_outside_edit_with_code_inside_a_link_keeps_every_paragraph_formatted() {
        let markdown = "# Notes

Some **bold** and a [link](https://a.example).

Run `make` and see [`npm install`](https://docs.example/install).
";
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, markdown)
            .expect("folds");
        assert_eq!(doc.project_richdoc().expect("projects"), markdown);
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = doc.doc.transact();
        let blocks: Vec<Value> = body
            .children(&txn)
            .flat_map(|child| runs_of(&xml_json(&txn, child)))
            .collect();
        let link = |href: &str| json!({ "href": href, "target": "_blank", "rel": LINK_REL, "class": null, "title": null });
        assert_eq!(
            normalized(&Value::Array(blocks)),
            normalized(&json!([
                { "t": "heading", "a": { "level": 1 }, "c": [{ "x": "Notes" }] },
                { "t": "paragraph", "c": [
                    { "x": "Some " },
                    { "x": "bold", "m": { "bold": {} } },
                    { "x": " and a " },
                    { "x": "link", "m": { "link": link("https://a.example") } },
                    { "x": "." },
                ] },
                { "t": "paragraph", "c": [
                    { "x": "Run " },
                    { "x": "make", "m": { "code": {} } },
                    { "x": " and see " },
                    { "x": "npm install", "m": { "code": {}, "link": link("https://docs.example/install") } },
                    { "x": "." },
                ] },
            ]))
        );
    }

    #[test]
    fn a_reference_label_that_crosses_a_code_span_keeps_the_raw_reading() {
        let read = |text: &str| read_inline(text, true);
        assert!(read("**a `x**[`]**").is_none());
        assert!(read("**a `x**[a[b]` q** [l](u \"`][r]\")").is_none());
        assert!(read("**a `x[0]`** and [b](https://b.example)").is_some());
    }

    fn runs(text: &str) -> Option<Vec<(String, Vec<MarkKind>)>> {
        read_inline(text, true).map(|pieces| {
            pieces
                .into_iter()
                .map(|piece| match piece {
                    InlinePiece::Text(run) => {
                        (run.text, run.marks.iter().map(|mark| mark.kind).collect())
                    }
                    InlinePiece::Image(_) => panic!("no image here"),
                })
                .collect()
        })
    }

    #[test]
    fn the_references_the_projector_writes_are_read_as_their_characters() {
        let text = |text: &str| (text.to_owned(), vec![]);
        let italic = |text: &str| (text.to_owned(), vec![MarkKind::Italic]);
        assert_eq!(runs("&amp;"), Some(vec![text("&")]));
        assert_eq!(
            runs("*em* &amp; &lt;b&gt; and **s**"),
            Some(vec![
                italic("em"),
                text(" & <b> and "),
                ("s".into(), vec![MarkKind::Bold]),
            ])
        );
        assert_eq!(
            runs("`&amp;` &amp;lt; *x*"),
            Some(vec![
                ("&amp;".into(), vec![MarkKind::Code]),
                text(" &lt; "),
                italic("x"),
            ])
        );
        assert_eq!(
            runs("[a &amp; b](https://e.example) *em*"),
            Some(vec![
                ("a & b".into(), vec![MarkKind::Link]),
                text(" "),
                italic("em"),
            ])
        );
        for unread in [
            "a &copy; *x*",
            "AT&T *x*",
            "x &amp *y*",
            "a &AMP; *x*",
            "&l&amp;t; *x*",
            "[a](https://e.example/?a=1&amp;b=2) *x*",
        ] {
            assert!(runs(unread).is_none(), "{unread:?}");
        }
    }

    #[test]
    fn a_code_span_holding_angle_brackets_or_ampersands_keeps_the_formatting_around_it() {
        let code = vec![MarkKind::Code];
        let italic = vec![MarkKind::Italic];
        assert_eq!(
            runs("Use `a<b> & {c}` and *em*"),
            Some(vec![
                ("Use ".into(), vec![]),
                ("a<b> & {c}".into(), code.clone()),
                (" and ".into(), vec![]),
                ("em".into(), italic),
            ])
        );
        assert_eq!(
            runs("``<a`b`` *x* ``c`>``"),
            Some(vec![
                ("<a`b".into(), code.clone()),
                (" *x* ".into(), vec![]),
                ("c`>".into(), code),
            ])
        );
        assert!(runs("Use <b> and *em*").is_none());
        assert!(runs("*a ``q`&#42;*x* y`` z*").is_none());
        assert!(runs("*a ``q`&AMP;#42;*x* y`` z*").is_none());
        assert!(runs("[a](https://e.example/?a=1&b=2) *em*").is_none());
    }

    #[test]
    fn a_note_dense_with_links_keeps_within_the_projection_limit() {
        let markdown = format!("{}end\n", "[x](u) ".repeat(34_000));
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &markdown)
            .expect("folds");
        assert!(doc.project_richdoc().is_ok());
        let crowded = format!(
            "{}{}end\n",
            "p\n\n".repeat(70_000),
            "[x](u) ".repeat(10_000)
        );
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &crowded)
            .expect("folds");
        assert!(doc.project_richdoc().is_ok());
        let links = format!("{}end\n", "[x](u) ".repeat(10_000));
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &links)
            .expect("folds");
        doc.rewrite_content_to_markdown_for_fold(
            ContentKind::Richdoc,
            &format!("{}{links}", "p\n\n".repeat(70_000)),
        )
        .expect("folds");
        assert!(doc.project_richdoc().is_ok());
        let properties: String = ('a'..='j').map(|key| format!("{key}: 1\n")).collect();
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(
            ContentKind::Richdoc,
            &format!("---\n{properties}---\n{}end\n", "[x](u) ".repeat(32_767)),
        )
        .expect("folds");
        assert!(doc.project_richdoc().is_ok());
    }

    #[test]
    fn a_note_too_dense_to_format_saves_only_its_raw_reading_and_keeps_it() {
        let paragraph = format!("{}end", "[x](u) ".repeat(40_000));
        let doc = Ydoc::wire();
        let update = doc
            .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &format!("{paragraph}\n"))
            .expect("folds");
        assert!(update.len() < 2 * paragraph.len(), "{} bytes", update.len());
        let update = doc
            .rewrite_content_to_markdown_for_fold(
                ContentKind::Richdoc,
                &format!("{paragraph}\n\nAdded.\n"),
            )
            .expect("folds");
        assert!(update.len() < 1_000, "{} bytes", update.len());
    }

    #[test]
    fn an_outside_save_keeps_the_linked_paragraphs_it_left_alone() {
        let paragraph = format!("{}end", "[x](u) ".repeat(6_800));
        let markdown = format!("{paragraph}\n\n{paragraph}\n");
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &markdown)
            .expect("folds");
        let update = doc
            .rewrite_content_to_markdown_for_fold(
                ContentKind::Richdoc,
                &format!("{markdown}\nAdded.\n"),
            )
            .expect("folds");
        assert!(update.len() < 1_000, "{} bytes", update.len());
    }

    #[test]
    fn unclosed_delimiters_stop_the_reading_early() {
        for unit in ["*", "_", "~"] {
            let text = format!("{}end", format!("{unit}word ").repeat(20_000));
            assert!(read_inline(&text, true).is_none());
        }
        let text = format!("{}end", "**word** ".repeat(20_000));
        assert!(read_inline(&text, true).is_some());
    }

    #[test]
    fn a_long_run_of_intraword_underscores_stops_the_reading_early() {
        assert!(read_inline(&"a_".repeat(20_000), true).is_none());
        let prose = format!("{}end", "plain words and *one* more ".repeat(5_000));
        assert!(read_inline(&prose, true).is_some());
    }

    #[test]
    fn unmatched_backtick_runs_stop_the_reading_early() {
        let runs: String = (1..=1_000)
            .map(|width| format!("{} x ", "`".repeat(width)))
            .collect();
        assert!(read_inline(&format!("{runs}end"), true).is_none());
        let pieces = read_inline("a `code` span", true).expect("matched span");
        assert!(pieces.iter().any(|piece| matches!(
            piece,
            InlinePiece::Text(run) if run.text == "code" && run.marks.iter().any(|mark| mark.kind == MarkKind::Code)
        )));
    }
}
