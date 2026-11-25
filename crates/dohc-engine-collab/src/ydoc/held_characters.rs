use std::collections::HashSet;
use std::sync::OnceLock;

use super::{is_js_whitespace, ProjectionBuffer, ProjectionResult};

pub(super) const OPAQUE_OPEN: char = '\u{e000}';
pub(super) const OPAQUE_CLOSE: char = '\u{e001}';
pub(super) const SCOPE_OPEN: char = '\u{e002}';
pub(super) const SCOPE_CLOSE: char = '\u{e003}';
pub(super) const TYPED: char = '\u{e004}';
pub(super) const LITERAL: char = '\u{e005}';

const PAIRING_WORK_PER_CELL: usize = 256;
const PAIRING_MINIMUM_CELLS: usize = 256;
const PAIRING_WORK_LIMIT: usize = 1 << 21;
const PAIRING_CELL_LIMIT: usize = 1 << 16;

pub(super) fn is_marker(character: char) -> bool {
    (OPAQUE_OPEN..=LITERAL).contains(&character)
}

/// The bytes of `text` that are written, leaving out the markers.
pub(super) fn written_len(text: &str) -> usize {
    let lead = OPAQUE_OPEN.encode_utf8(&mut [0; 4]).as_bytes()[0];
    if !text.as_bytes().contains(&lead) {
        return text.len();
    }
    text.chars()
        .filter(|&character| !is_marker(character))
        .map(char::len_utf8)
        .sum()
}

pub(super) fn escape_markers(text: String) -> String {
    if !text.chars().any(is_marker) {
        return text;
    }
    let mut escaped = String::with_capacity(text.len() + 3);
    for character in text.chars() {
        if is_marker(character) {
            escaped.push(LITERAL);
        }
        escaped.push(character);
    }
    escaped
}

pub(super) fn hold_typed(text: &str) -> String {
    let mut held = String::with_capacity(text.len());
    let mut depth = 0usize;
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        match character {
            LITERAL => {
                held.push(character);
                held.extend(characters.next());
                continue;
            }
            OPAQUE_OPEN => depth += 1,
            OPAQUE_CLOSE => depth = depth.saturating_sub(1),
            '*' | '_' | '`' | '\\' if depth == 0 => held.push(TYPED),
            _ => {}
        }
        held.push(character);
    }
    held
}

/// The text as it is written, with each held character as itself.
pub(super) fn resolved(text: &str) -> String {
    let mut written = String::with_capacity(text.len());
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        match character {
            OPAQUE_OPEN | OPAQUE_CLOSE | SCOPE_OPEN | SCOPE_CLOSE => {}
            TYPED | LITERAL => written.extend(characters.next()),
            _ => written.push(character),
        }
    }
    written
}

fn class(pattern: &str) -> Vec<(char, char)> {
    use regex_syntax::hir::{Class, HirKind};
    let hir = regex_syntax::Parser::new()
        .parse(pattern)
        .expect("a Unicode class parses");
    match hir.kind() {
        HirKind::Class(Class::Unicode(class)) => class
            .ranges()
            .iter()
            .map(|range| (range.start(), range.end()))
            .collect(),
        _ => unreachable!("a Unicode class"),
    }
}

fn in_class(ranges: &[(char, char)], character: char) -> bool {
    ranges
        .binary_search_by(|&(start, end)| {
            if end < character {
                std::cmp::Ordering::Less
            } else if start > character {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

pub(super) fn is_punctuation(character: char) -> bool {
    static PUNCTUATION: OnceLock<Vec<(char, char)>> = OnceLock::new();
    if character.is_ascii() {
        return character.is_ascii_punctuation();
    }
    in_class(
        PUNCTUATION.get_or_init(|| class(r"[\p{P}\p{S}]")),
        character,
    )
}

fn is_letter_or_number(character: char) -> bool {
    static LETTERS: OnceLock<Vec<(char, char)>> = OnceLock::new();
    if character.is_ascii() {
        return character.is_ascii_alphanumeric();
    }
    in_class(LETTERS.get_or_init(|| class(r"[\p{L}\p{N}]")), character)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shown {
    Reference,
    Character(char),
}

impl Shown {
    fn is(self, expected: char) -> bool {
        self == Shown::Character(expected)
    }

    fn space(self) -> bool {
        matches!(self, Shown::Character(character) if is_js_whitespace(character))
    }

    fn punctuation(self) -> bool {
        matches!(self, Shown::Character(character) if is_punctuation(character))
    }

    fn character(self) -> Option<char> {
        match self {
            Shown::Reference => None,
            Shown::Character(character) => Some(character),
        }
    }
}

enum Cell {
    Text { first: Shown, last: Shown },
    Delimiter(char),
    Held { character: char, at: usize },
    Opaque(String),
    Open { close: usize },
    Close,
}

#[derive(Clone, Copy)]
enum Side {
    First,
    Last,
}

/// Writes each typed `*`, `_`, backtick, and backslash `markdown` holds. One
/// the reader would take as a delimiter, or one that keeps a written delimiter
/// from pairing, is written as a reference. A backslash before ASCII
/// punctuation is doubled. The others are written as they are, so text that
/// reads back keeps its bytes. When `judged`, `strands` says whether a
/// written bold, italic, or strike delimiter would read as text. Modeling how the reader
/// pairs them takes at most [`PAIRING_CELL_LIMIT`] cells,
/// [`PAIRING_WORK_PER_CELL`] steps per cell, and [`PAIRING_WORK_LIMIT`] steps
/// in all. Past that, every typed character is written as it is.
pub(super) fn write_held_characters(markdown: String, judged: bool) -> ProjectionResult<Written> {
    let holds = markdown.contains(TYPED);
    let (decided, strands) = if holds || (judged && markdown.contains(['*', '_', '~'])) {
        cells_of(&markdown).map_or((Vec::new(), false), |cells| decide(&cells, holds))
    } else {
        (Vec::new(), false)
    };
    if !markdown.chars().any(is_marker) {
        return Ok(Written {
            text: markdown,
            strands,
        });
    }
    let mut written = ProjectionBuffer::with_capacity(written_len(&markdown))?;
    let mut at = 0usize;
    let mut characters = markdown.chars();
    while let Some(character) = characters.next() {
        match character {
            OPAQUE_OPEN | OPAQUE_CLOSE | SCOPE_OPEN | SCOPE_CLOSE => {}
            LITERAL => {
                if let Some(literal) = characters.next() {
                    written.push(literal)?;
                }
            }
            TYPED => {
                let held = characters.next().expect("a held character follows");
                match decided.get(at).and_then(Option::as_deref) {
                    Some(decision) => written.push_str(decision)?,
                    None => written.push(held)?,
                }
                at += 1;
            }
            _ => written.push(character)?,
        }
    }
    Ok(Written {
        text: written.into_string(),
        strands,
    })
}

pub(super) struct Written {
    pub(super) text: String,
    pub(super) strands: bool,
}

fn decide(cells: &[Cell], holds: bool) -> (Vec<Option<String>>, bool) {
    let mut escaped = vec![false; cells.len()];
    escape_backticks_beside_code(cells, &mut escaped);
    let mut pairing = Pairing::new(cells, escaped);
    let Ok(strands) = pairing.escape_pairs() else {
        return (Vec::new(), false);
    };
    if !holds {
        return (Vec::new(), strands);
    }
    let escaped = pairing.escaped;
    let mut decided = Vec::new();
    for (index, cell) in cells.iter().enumerate() {
        let Cell::Held { character, at } = *cell else {
            continue;
        };
        let decision = if escaped[index] {
            format!("&#{};", u32::from(character))
        } else if character == '\\' && escapes_next(cells, &escaped, index) {
            "\\\\".to_owned()
        } else {
            character.to_string()
        };
        if decided.len() <= at {
            decided.resize(at + 1, None);
        }
        decided[at] = Some(decision);
    }
    (decided, strands)
}

fn holds_past_cell_limit(markdown: &str) -> bool {
    let mut held = 0usize;
    let mut characters = markdown.chars();
    while let Some(character) = characters.next() {
        match character {
            LITERAL => {
                characters.next();
            }
            TYPED => {
                held += 1;
                if held > PAIRING_CELL_LIMIT {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn cells_of(markdown: &str) -> Option<Vec<Cell>> {
    if holds_past_cell_limit(markdown) {
        return None;
    }
    let mut cells = Vec::new();
    let mut scopes: Vec<usize> = Vec::new();
    let mut plain = String::new();
    let mut opaque = String::new();
    let mut depth = 0usize;
    let mut at = 0usize;
    let mut characters = markdown.chars();
    while let Some(character) = characters.next() {
        if cells.len() > PAIRING_CELL_LIMIT {
            return None;
        }
        let written = match character {
            TYPED => {
                let held = characters.next().expect("a held character follows");
                if depth > 0 {
                    opaque.push(held);
                } else {
                    flush(&mut cells, &mut plain);
                    cells.push(Cell::Held {
                        character: held,
                        at,
                    });
                }
                at += 1;
                continue;
            }
            LITERAL => characters.next(),
            OPAQUE_OPEN => {
                if depth == 0 {
                    flush(&mut cells, &mut plain);
                }
                depth += 1;
                continue;
            }
            OPAQUE_CLOSE => {
                if depth == 0 {
                    flush(&mut cells, &mut plain);
                } else {
                    depth -= 1;
                    if depth == 0 {
                        cells.push(Cell::Opaque(std::mem::take(&mut opaque)));
                    }
                }
                continue;
            }
            SCOPE_OPEN | SCOPE_CLOSE if depth > 0 => continue,
            SCOPE_OPEN => {
                flush(&mut cells, &mut plain);
                scopes.push(cells.len());
                cells.push(Cell::Open { close: usize::MAX });
                continue;
            }
            SCOPE_CLOSE => {
                flush(&mut cells, &mut plain);
                if let Some(open) = scopes.pop() {
                    let close = cells.len();
                    cells[open] = Cell::Open { close };
                    cells.push(Cell::Close);
                }
                continue;
            }
            _ => Some(character),
        };
        if let Some(written) = written {
            if depth > 0 {
                opaque.push(written);
            } else {
                plain.push(written);
            }
        }
    }
    flush(&mut cells, &mut plain);
    if cells.len() > PAIRING_CELL_LIMIT {
        return None;
    }
    for open in scopes {
        cells[open] = Cell::Close;
    }
    Some(cells)
}

fn reference_len(text: &str) -> Option<usize> {
    let rest = text
        .strip_prefix("&amp;#")
        .or_else(|| text.strip_prefix("&#"))?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest.as_bytes().get(digits) == Some(&b';'))
        .then(|| text.len() - rest.len() + digits + 1)
}

fn flush(cells: &mut Vec<Cell>, plain: &mut String) {
    let mut rest = plain.as_str();
    while let Some(character) = rest.chars().next() {
        if cells.len() > PAIRING_CELL_LIMIT {
            break;
        }
        let width = if character == '&' {
            reference_len(rest)
        } else if rest.starts_with("\\=") {
            Some(2)
        } else {
            None
        };
        rest = &rest[width.unwrap_or(character.len_utf8())..];
        let shown = if width.is_some() {
            Shown::Reference
        } else {
            Shown::Character(character)
        };
        let joins_run = matches!(shown, Shown::Character(next) if !matches!(next, '*' | '_' | '`'))
            && matches!(
                cells.last(),
                Some(Cell::Text { first: Shown::Character(first), .. }) if *first != '`'
            );
        if joins_run {
            if let Some(Cell::Text { last, .. }) = cells.last_mut() {
                *last = shown;
            }
        } else {
            cells.push(match shown {
                Shown::Character(delimiter @ ('*' | '_')) => Cell::Delimiter(delimiter),
                _ => Cell::Text {
                    first: shown,
                    last: shown,
                },
            });
        }
    }
    plain.clear();
}

fn escapes_next(cells: &[Cell], escaped: &[bool], index: usize) -> bool {
    if ends_underline(cells, index) {
        return false;
    }
    match char_after(cells, escaped, index + 1, cells.len()) {
        Some(Shown::Reference) => true,
        Some(Shown::Character(next)) => next.is_ascii_punctuation(),
        None => false,
    }
}

fn ends_underline(cells: &[Cell], index: usize) -> bool {
    matches!(cells.get(index + 1), Some(Cell::Opaque(written)) if written == "++")
        && matches!(cells.get(index + 2), Some(Cell::Close))
}

fn shown(cell: &Cell, escaped: &[bool], index: usize, side: Side) -> Option<Shown> {
    match cell {
        Cell::Text { first, last } => Some(match side {
            Side::First => *first,
            Side::Last => *last,
        }),
        Cell::Delimiter(character) => Some(Shown::Character(*character)),
        Cell::Held { character, .. } => Some(if escaped[index] {
            Shown::Reference
        } else {
            Shown::Character(*character)
        }),
        Cell::Opaque(written) => match side {
            Side::First => written.chars().next(),
            Side::Last => written.chars().next_back(),
        }
        .map(Shown::Character),
        Cell::Open { .. } | Cell::Close => None,
    }
}

fn char_after(cells: &[Cell], escaped: &[bool], from: usize, to: usize) -> Option<Shown> {
    (from..to).find_map(|index| shown(&cells[index], escaped, index, Side::First))
}

fn char_before(cells: &[Cell], escaped: &[bool], end: usize) -> Option<Shown> {
    (0..end)
        .rev()
        .find_map(|index| shown(&cells[index], escaped, index, Side::Last))
}

#[derive(Clone, Copy)]
struct Backtick {
    index: usize,
    held: bool,
}

fn backtick_runs(
    cells: &[Cell],
    escaped: &[bool],
    from: usize,
    to: usize,
    masking: bool,
    until: impl Fn(&[Vec<Backtick>]) -> bool,
) -> Vec<Vec<Backtick>> {
    let mut found: Vec<Vec<Backtick>> = Vec::new();
    let mut run: Vec<Backtick> = Vec::new();
    let end = |found: &mut Vec<Vec<Backtick>>, run: &mut Vec<Backtick>| {
        if !run.is_empty() {
            found.push(std::mem::take(run));
        }
        until(found)
    };
    for index in from..to {
        match &cells[index] {
            Cell::Held { character, .. } => {
                if *character == '`' && !escaped[index] {
                    run.push(Backtick { index, held: true });
                } else if end(&mut found, &mut run) {
                    return found;
                }
            }
            Cell::Opaque(written) => {
                let escapes = masking || !written.starts_with('`');
                let mut characters = written.chars().peekable();
                while let Some(character) = characters.next() {
                    if escapes
                        && character == '\\'
                        && characters.peek().is_some_and(char::is_ascii_punctuation)
                    {
                        characters.next();
                    } else if character == '`' {
                        run.push(Backtick { index, held: false });
                        continue;
                    }
                    if end(&mut found, &mut run) {
                        return found;
                    }
                }
            }
            Cell::Text { first, .. } => {
                if first.is('`') {
                    run.push(Backtick { index, held: false });
                } else if end(&mut found, &mut run) {
                    return found;
                }
            }
            Cell::Delimiter(_) => {
                if end(&mut found, &mut run) {
                    return found;
                }
            }
            Cell::Open { .. } | Cell::Close => {}
        }
    }
    end(&mut found, &mut run);
    found
}

fn escape_backticks_beside_code(cells: &[Cell], escaped: &mut [bool]) {
    for run in backtick_runs(cells, escaped, 0, cells.len(), false, |_| false) {
        if run.iter().any(|backtick| backtick.held) && run.iter().any(|backtick| !backtick.held) {
            for backtick in run.iter().filter(|backtick| backtick.held) {
                escaped[backtick.index] = true;
            }
        }
    }
}

struct PairingTooLong;

type Pairs<T> = Result<T, PairingTooLong>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flank {
    Open,
    Close,
    Both,
}

struct Match {
    from: usize,
    width: usize,
    end: usize,
}

struct Pairing<'a> {
    cells: &'a [Cell],
    escaped: Vec<bool>,
    consumed: Vec<bool>,
    blockers: Vec<bool>,
    broken: bool,
    work: isize,
}

impl<'a> Pairing<'a> {
    fn new(cells: &'a [Cell], escaped: Vec<bool>) -> Self {
        let work = (cells.len().max(PAIRING_MINIMUM_CELLS) * PAIRING_WORK_PER_CELL)
            .min(PAIRING_WORK_LIMIT);
        Self {
            cells,
            escaped,
            consumed: vec![false; cells.len()],
            blockers: vec![false; cells.len()],
            broken: false,
            work: isize::try_from(work).unwrap_or(isize::MAX),
        }
    }

    fn spend(&mut self, from: usize, to: usize) -> Pairs<()> {
        self.work -= to as isize - from as isize;
        if self.work < 0 {
            Err(PairingTooLong)
        } else {
            Ok(())
        }
    }

    fn delimits(&self, index: usize, character: char) -> bool {
        match self.cells[index] {
            Cell::Delimiter(delimiter) => delimiter == character,
            Cell::Held {
                character: held, ..
            } => held == character && !self.escaped[index],
            _ => false,
        }
    }

    fn shown(&self, index: usize, side: Side) -> Option<Shown> {
        shown(&self.cells[index], &self.escaped, index, side)
    }

    fn after(&self, from: usize, to: usize) -> Option<Shown> {
        char_after(self.cells, &self.escaped, from, to)
    }

    fn before(&self, end: usize) -> Option<Shown> {
        char_before(self.cells, &self.escaped, end)
    }

    fn close_of(&self, open: usize) -> usize {
        match self.cells[open] {
            Cell::Open { close } => close,
            _ => unreachable!("a scope opens here"),
        }
    }

    fn inner(&self, open: usize) -> (usize, usize) {
        let close = self.close_of(open);
        let opaque = |index: Option<usize>| {
            matches!(
                index.and_then(|index| self.cells.get(index)),
                Some(Cell::Opaque(_))
            )
        };
        (
            open + 1 + usize::from(opaque(Some(open + 1))),
            close - usize::from(opaque(close.checked_sub(1))),
        )
    }

    fn is_link(&self, open: usize) -> bool {
        matches!(self.cells.get(open + 1), Some(Cell::Opaque(written)) if written.starts_with('['))
    }

    fn opens_strike(&self, index: usize) -> bool {
        matches!(self.cells.get(index), Some(Cell::Open { .. }))
            && matches!(self.cells.get(index + 1), Some(Cell::Opaque(written)) if written == "~~")
    }

    fn runs(&self, from: usize, to: usize) -> Vec<Vec<Backtick>> {
        backtick_runs(self.cells, &self.escaped, from, to, false, |_| false)
    }

    fn code_spans(&self, from: usize, to: usize) -> Vec<Vec<Backtick>> {
        let runs = backtick_runs(self.cells, &self.escaped, from, to, true, |_| false);
        let mut spans = Vec::new();
        let mut at = 0;
        while at + 1 < runs.len() {
            if runs[at].len() == runs[at + 1].len() {
                spans.push([runs[at].as_slice(), runs[at + 1].as_slice()].concat());
                at += 1;
            }
            at += 1;
        }
        spans
    }

    fn mask_code_spans(&self, from: usize, to: usize) -> HashSet<usize> {
        let mut hidden = HashSet::new();
        for span in self.code_spans(from, to) {
            let last = span.last().expect("a span holds a backtick").index;
            hidden.extend(span[0].index..=last);
        }
        hidden
    }

    fn backticks_hiding_loose(&self) -> Vec<usize> {
        let mut loose_before = vec![0];
        for (index, cell) in self.cells.iter().enumerate() {
            let loose = matches!(cell, Cell::Delimiter(_)) && !self.consumed[index];
            loose_before.push(loose_before[index] + usize::from(loose));
        }
        self.code_spans(0, self.cells.len())
            .into_iter()
            .filter(|span| {
                let last = span.last().expect("a span holds a backtick").index;
                loose_before[last] > loose_before[span[0].index + 1]
            })
            .flatten()
            .filter_map(|backtick| backtick.held.then_some(backtick.index))
            .collect()
    }

    fn past_orphan_in_strong(
        &self,
        from: usize,
        to: usize,
        character: char,
        masked: &HashSet<usize>,
    ) -> usize {
        let strong = if character == '*' { '_' } else { '*' };
        let mut index = from;
        let plain = |index: &mut usize| {
            while *index < to
                && (masked.contains(index)
                    || (!self.delimits(*index, '*') && !self.delimits(*index, '_')))
            {
                *index = match self.cells[*index] {
                    Cell::Open { close } if close < to && self.is_link(*index) => close + 1,
                    _ => *index + 1,
                };
            }
        };
        let pair = |index: usize| {
            index + 1 < to && self.delimits(index, strong) && self.delimits(index + 1, strong)
        };
        plain(&mut index);
        if !pair(index) {
            return from;
        }
        index += 2;
        plain(&mut index);
        if !(index < to && self.delimits(index, character)) {
            return from;
        }
        index += 1;
        plain(&mut index);
        if pair(index) {
            index
        } else {
            from
        }
    }

    fn classify(star: bool, before: Option<Shown>, after: Option<Shown>) -> Option<Flank> {
        let punctuation = |shown: Shown| shown.punctuation() && !(star && shown.is('~'));
        let space_after = after.is_none_or(Shown::space);
        let Some(before) = before.filter(|before| !before.space()) else {
            return (!space_after).then_some(Flank::Open);
        };
        if punctuation(before) {
            if space_after {
                return Some(Flank::Close);
            }
            return Some(if after.is_some_and(punctuation) {
                Flank::Both
            } else {
                Flank::Open
            });
        }
        if space_after || after.is_some_and(punctuation) {
            return Some(Flank::Close);
        }
        star.then_some(Flank::Both)
    }

    fn em_strong(
        &mut self,
        from: usize,
        to: usize,
        before: Option<Shown>,
        masked: &HashSet<usize>,
    ) -> Pairs<Option<Match>> {
        let Some(Shown::Character(character)) = self.shown(from, Side::First) else {
            unreachable!("a delimiter opens here");
        };
        let star = character == '*';
        let mut end = from;
        while end < to && self.delimits(end, character) {
            end += 1;
        }
        self.spend(from, end)?;
        let length = end - from;
        let Some(after) = self.after(end, to).filter(|after| !after.space()) else {
            return Ok(None);
        };
        let punctuation_after = after.punctuation() && !after.is('~');
        if !star
            && !punctuation_after
            && before
                .and_then(Shown::character)
                .is_some_and(is_letter_or_number)
        {
            return Ok(None);
        }
        if punctuation_after
            && before.is_some_and(|before| {
                before.is('*') || before.is('_') || !(before.space() || before.punctuation())
            })
        {
            return Ok(None);
        }
        let mut open = length as isize;
        let mut middle = 0isize;
        let mut index = self.past_orphan_in_strong(end, to, character, masked);
        let mut found = None;
        while index < to && found.is_none() {
            if let Cell::Open { close } = self.cells[index] {
                if close < to && self.is_link(index) {
                    index = close + 1;
                    continue;
                }
            }
            if masked.contains(&index) || !self.delimits(index, character) {
                index += 1;
                continue;
            }
            let start = index;
            while index < to && !masked.contains(&index) && self.delimits(index, character) {
                index += 1;
            }
            let size = (index - start) as isize;
            let kind = Self::classify(star, self.before(start), self.after(index, to));
            match kind {
                None => continue,
                Some(Flank::Open) => {
                    open += size;
                    continue;
                }
                Some(Flank::Both) if length % 3 != 0 && (length as isize + size) % 3 == 0 => {
                    middle += size;
                    continue;
                }
                _ => {}
            }
            open -= size;
            if open > 0 {
                continue;
            }
            let used = size.min(size + open + middle);
            found = Some(Match {
                from,
                width: if (length as isize).min(used) % 2 != 0 {
                    1
                } else {
                    2
                },
                end: (start as isize + used) as usize,
            });
        }
        self.spend(end, index)?;
        Ok(found)
    }

    fn letter(shown: Option<Shown>) -> bool {
        shown.is_some_and(|shown| !shown.space() && !shown.punctuation())
    }

    fn strike_forms(
        &mut self,
        open: usize,
        to: usize,
        before: Option<Shown>,
        masked: &HashSet<usize>,
    ) -> bool {
        let close = self.close_of(open);
        if masked.contains(&(close - 1)) {
            return false;
        }
        let first = self.after(open + 2, close - 1);
        let last = self.before(close - 1);
        let next = self.after(close + 1, to);
        let opens = first.is_some_and(|first| !first.space() && !first.is('~'))
            && (Self::letter(first)
                || before.is_none()
                || (!Self::letter(before)
                    && before.is_some_and(|before| !before.is('*') && !before.is('_'))));
        let closes = Self::letter(last)
            || (last.is_some_and(|last| !last.space() && !last.is('~')) && !Self::letter(next));
        if opens && closes {
            return true;
        }
        self.broken = true;
        let around = [
            open.checked_sub(1),
            Some(open + 2),
            close.checked_sub(2),
            Some(close + 1),
        ];
        for at in around.into_iter().flatten() {
            if let Some(Cell::Held { character, .. }) = self.cells.get(at) {
                if *character != '\\' && self.delimits(at, *character) {
                    self.blockers[at] = true;
                }
            }
        }
        false
    }

    fn hold_label_backticks(&mut self, from: usize, to: usize) {
        let runs = self.runs(from, to);
        let Some(last) = runs.last() else {
            return;
        };
        if runs.len() % 2 == 0 {
            return;
        }
        let end = last.last().expect("a run holds a backtick").index;
        let at_end = self.after(end + 1, to).is_none()
            && self.shown(end, Side::Last) == Some(Shown::Character('`'));
        if last.len() >= 2 && at_end {
            return;
        }
        if let Some(held) = runs
            .iter()
            .find(|run| run.iter().all(|backtick| backtick.held))
        {
            for backtick in held {
                self.blockers[backtick.index] = true;
            }
        }
    }

    fn lex(&mut self, from: usize, to: usize) -> Pairs<()> {
        self.spend(from, to)?;
        let masked = self.mask_code_spans(from, to);
        let mut before: Option<Shown> = None;
        let mut index = from;
        while index < to {
            match self.cells[index] {
                Cell::Open { close } => {
                    self.broken |= close >= to;
                    if close < to
                        && (!self.opens_strike(index)
                            || self.strike_forms(index, to, before, &masked))
                    {
                        let (inner_from, inner_to) = self.inner(index);
                        self.lex(inner_from, inner_to)?;
                        if self.is_link(index) {
                            self.hold_label_backticks(inner_from, inner_to);
                        }
                        before = None;
                        index = close + 1;
                    } else {
                        index += 1;
                    }
                    continue;
                }
                Cell::Close => {
                    self.broken = true;
                    index += 1;
                    continue;
                }
                Cell::Opaque(_) => {
                    before = None;
                    index += 1;
                    continue;
                }
                _ => {}
            }
            let shown = self
                .shown(index, Side::First)
                .expect("text shows a character");
            if matches!(self.cells[index], Cell::Held { .. }) && shown.is('`') {
                let found = backtick_runs(self.cells, &self.escaped, index, to, false, |runs| {
                    runs.len() > 1 && runs[runs.len() - 1].len() == runs[0].len()
                });
                let run = &found[0];
                let last = &found[found.len() - 1];
                let partner = (found.len() > 1 && last.len() == run.len()).then_some(last);
                let reach = partner.map_or(to, |partner| {
                    partner.last().expect("a run holds a backtick").index + 1
                });
                self.spend(index, reach)?;
                let run_end = run.last().expect("a run holds a backtick").index;
                if partner.is_some() {
                    for backtick in run {
                        self.consumed[backtick.index] = true;
                    }
                } else if self.opens_strike(run_end + 1) {
                    for backtick in run {
                        self.blockers[backtick.index] = true;
                    }
                }
                before = if partner.is_some() { None } else { Some(shown) };
                index = partner.map_or(run_end, |partner| {
                    partner.last().expect("a run holds a backtick").index
                }) + 1;
                continue;
            }
            if let Shown::Character(character @ ('*' | '_')) = shown {
                if self.delimits(index, character) {
                    if let Some(found) = self.em_strong(index, to, before, &masked)? {
                        for offset in 0..found.width {
                            self.consumed[found.from + offset] = true;
                            self.consumed[found.end - 1 - offset] = true;
                        }
                        self.lex(found.from + found.width, found.end - found.width)?;
                        before = None;
                        index = found.end;
                        continue;
                    }
                }
            }
            let last = self
                .shown(index, Side::Last)
                .expect("text shows a character");
            if !last.is('_') {
                before = Some(last);
            }
            index += 1;
        }
        Ok(())
    }

    fn escape_run(&mut self, index: usize) {
        let Cell::Held { character, .. } = self.cells[index] else {
            return;
        };
        let held_delimiter = |pairing: &Self, at: usize| {
            matches!(pairing.cells[at], Cell::Held { .. }) && pairing.delimits(at, character)
        };
        let mut from = index;
        while from > 0 && held_delimiter(self, from - 1) {
            from -= 1;
        }
        let mut at = from;
        while at < self.cells.len() && held_delimiter(self, at) {
            self.escaped[at] = true;
            at += 1;
        }
    }

    fn escape_pairs(&mut self) -> Pairs<bool> {
        let cells = self.cells;
        loop {
            self.consumed.fill(false);
            self.blockers.fill(false);
            self.broken = false;
            self.lex(0, cells.len())?;
            let taken: Vec<usize> = (0..cells.len())
                .filter(|&index| matches!(cells[index], Cell::Held { .. }) && self.consumed[index])
                .collect();
            for &index in &taken {
                self.escape_run(index);
            }
            if !taken.is_empty() {
                continue;
            }
            let stranded: Vec<char> = ['*', '_']
                .into_iter()
                .filter(|&character| {
                    cells.iter().enumerate().any(|(index, cell)| {
                        matches!(cell, Cell::Delimiter(delimiter) if *delimiter == character)
                            && !self.consumed[index]
                    })
                })
                .collect();
            let beside_delimiter = |index: usize| {
                !stranded.is_empty()
                    && (index
                        .checked_sub(1)
                        .is_some_and(|before| matches!(cells[before], Cell::Delimiter(_)))
                        || matches!(cells.get(index + 1), Some(Cell::Delimiter(_))))
            };
            let mut blocking: Vec<usize> = (0..cells.len())
                .filter(|&index| {
                    let Cell::Held { character, .. } = cells[index] else {
                        return false;
                    };
                    if character == '\\' || !self.delimits(index, character) {
                        return false;
                    }
                    if beside_delimiter(index) || self.blockers[index] {
                        return true;
                    }
                    if !stranded.contains(&character) {
                        return false;
                    }
                    Self::classify(
                        character == '*',
                        self.before(index),
                        self.after(index + 1, cells.len()),
                    )
                    .is_some()
                })
                .collect();
            if blocking.is_empty() && !stranded.is_empty() {
                blocking = self.backticks_hiding_loose();
            }
            for &index in &blocking {
                self.escape_run(index);
            }
            if blocking.is_empty() {
                return Ok(!stranded.is_empty() || self.broken);
            }
        }
    }
}
