//! Folds a new tree onto a note stored as one sequence (format 2), keeping
//! every item the two share at either end. The rules are section 4 of
//! `docs/engineering/note-body-sequence.md`, and
//! `packages/ydoc-projection/src/fixtures/body-sequence-folds.json` pins what
//! each fold reads as.

use super::body_sequence::{self, Line, Slot, Stored, Trace, BOUNDARY, CONTAINERS, LEAVES};
use super::body_sequence_writer::{self, NewBody, Piece};
use super::*;
use yrs::types::text::TextItem;
use yrs::types::{Attrs, Delta};

const FRESH_ID_LETTERS: usize = 12;

#[cfg(test)]
thread_local! {
    pub(super) static SLOTS_VISITED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn visit(count: usize) {
    #[cfg(test)]
    SLOTS_VISITED.with(|visited| visited.set(visited.get() + count));
    let _ = count;
}

enum Wanted {
    Unit(u16, usize),
    Inline(usize),
    Line(usize),
}

struct WantedLine {
    tag: &'static str,
    attributes: Stored,
    frames: Vec<usize>,
}

struct WantedFrame {
    kind: &'static str,
    records: Vec<(String, Any)>,
}

#[derive(Default)]
struct Target {
    slots: Vec<Wanted>,
    marks: Vec<Attrs>,
    hidden: Vec<bool>,
    inline: Vec<(&'static str, Stored)>,
    lines: Vec<WantedLine>,
    frames: Vec<WantedFrame>,
}

impl Target {
    fn of(body: NewBody) -> Option<Target> {
        let mut target = Target::default();
        let mut numbers = HashMap::new();
        for (key, value) in body.records {
            match key.split_once('.') {
                Some((_, name)) => {
                    let frame = target.frames.last_mut()?;
                    frame.records.push((name.to_owned(), value));
                }
                None => {
                    let Any::String(kind) = &value else {
                        return None;
                    };
                    let kind = body_sequence::known(&CONTAINERS, kind)?;
                    numbers.insert(key, target.frames.len());
                    let records = Vec::new();
                    target.frames.push(WantedFrame { kind, records });
                }
            }
        }
        let mut code = false;
        for piece in body.pieces {
            let Delta::Inserted(piece, marks) = piece else {
                return None;
            };
            match piece {
                Piece::Letters(text) => {
                    let mut marks = marks.map_or_else(Attrs::new, |marks| *marks);
                    if marks.contains_key("code") {
                        marks.retain(|name, _| &**name == "code");
                    }
                    target.marks.push(marks);
                    target.hidden.push(code);
                    let marks = target.marks.len() - 1;
                    let units = text.encode_utf16().map(|unit| Wanted::Unit(unit, marks));
                    target.slots.extend(units);
                }
                Piece::Element {
                    tag: BOUNDARY,
                    attributes,
                } => {
                    let Some(Any::Array(ids)) = attributes.get("path") else {
                        return None;
                    };
                    let frame = |id: &Any| match id {
                        Any::String(id) => numbers.get(&**id).copied(),
                        _ => None,
                    };
                    let frames = ids.iter().map(frame).collect::<Option<Vec<_>>>()?;
                    let Some(Any::String(tag)) = attributes.get("type") else {
                        return None;
                    };
                    let tag = body_sequence::known(&LEAVES, tag)?;
                    code = tag == "codeBlock";
                    target.slots.push(Wanted::Line(target.lines.len()));
                    target.lines.push(WantedLine {
                        tag,
                        attributes,
                        frames,
                    });
                }
                Piece::Element { tag, attributes } => {
                    target.slots.push(Wanted::Inline(target.inline.len()));
                    target.inline.push((tag, attributes));
                }
            }
        }
        Some(target)
    }
}

fn same(before: &Trace, target: &Target, at: usize, wanted: usize) -> bool {
    visit(1);
    match (&before.slots[at], &target.slots[wanted]) {
        (Slot::Unit(unit, _), Wanted::Unit(other, _)) => unit == other,
        (Slot::Inline(item), Wanted::Inline(other)) => {
            before.inline[*item] == target.inline[*other]
        }
        (Slot::Line(_), Wanted::Line(_)) => true,
        _ => false,
    }
}

fn unit_in(slot: &Slot, surrogates: std::ops::Range<u16>) -> bool {
    matches!(slot, Slot::Unit(unit, _) if surrogates.contains(unit))
}

/// What a fold writes, worked out before anything is written.
pub(super) struct Fold {
    records: Vec<(String, Any)>,
    attributes: Vec<(yrs::XmlElementRef, &'static str, Any)>,
    formats: Vec<Delta<Piece>>,
    after: Vec<(u32, Stored)>,
    middle: Vec<Delta<Piece>>,
    placed: Vec<Delta<Piece>>,
    before: Vec<(u32, Stored)>,
}

pub(super) fn plan<T: ReadTxn>(
    txn: &T,
    client: yrs::ClientID,
    sequence: &yrs::TextRef,
    containers: &MapRef,
    body: NewBody,
) -> Result<Fold, CollabError> {
    let refused = || CollabError::MarkdownNotRepresentable;
    let before = body_sequence::traced(txn, sequence, containers)?;
    let target = Target::of(body).ok_or_else(refused)?;
    if before.unknown_width {
        return Err(refused());
    }
    let (have, want) = (before.slots.len(), target.slots.len());
    let mut start = 0;
    while start < have.min(want) && same(&before, &target, start, start) {
        start += 1;
    }
    start -= usize::from(start > 0 && unit_in(&before.slots[start - 1], 0xD800..0xDC00));
    let mut end = 0;
    while end < have.min(want) - start && same(&before, &target, have - 1 - end, want - 1 - end) {
        end += 1;
    }
    end -= usize::from(end > 0 && unit_in(&before.slots[have - end], 0xDC00..0xE000));
    if start + end == have.min(want) && have != want {
        let pair = |slid: usize| match have > want {
            true => (have - 1 - end - slid, start - 1 - slid),
            false => (start - 1 - slid, want - 1 - end - slid),
        };
        let mut slid = 0;
        while slid < start && {
            let (at, wanted) = pair(slid);
            same(&before, &target, at, wanted)
        } {
            slid += 1;
        }
        let opens = |slid: usize| match have > want {
            true => matches!(before.slots[start - slid], Slot::Line(_)),
            false => matches!(target.slots[start - slid], Wanted::Line(_)),
        };
        if let Some(slid) = (0..=slid).find(|&slid| opens(slid)) {
            (start, end) = (start - slid, end + slid);
        }
    }
    visit(have);
    let mut offsets = Vec::with_capacity(have + 1);
    let mut offset = 0_u32;
    for slot in &before.slots {
        offsets.push(offset);
        offset += match slot {
            Slot::Line(line) => u32::from(before.lines[*line].boundary.is_some()),
            _ => 1,
        };
    }
    offsets.push(offset);
    visit(start + end);
    let kept = (0..start).map(|at| (at, at));
    let kept = kept.chain((have - end..have).map(|at| (at, at + want - have)));
    let (mut formats, mut cursor, mut last) = (Vec::new(), 0, None);
    let mut touched = (usize::MAX, 0);
    for (at, wanted) in kept.clone() {
        let (Slot::Unit(_, had), Wanted::Unit(_, given)) =
            (&before.slots[at], &target.slots[wanted])
        else {
            continue;
        };
        let (had, shown) = (&before.marks[*had as usize], &target.marks[*given]);
        let coded = had.contains_key("code") && shown.contains_key("code");
        if had == shown || target.hidden[*given] || coded {
            continue;
        }
        touched = (touched.0.min(at), at);
        let mut diff: Attrs = shown
            .iter()
            .filter(|(name, value)| had.get(*name) != Some(*value))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        diff.extend(
            had.keys()
                .filter(|name| !shown.contains_key(*name))
                .map(|name| (name.clone(), Any::Null)),
        );
        if at + 1 == start {
            last = Some(diff.clone());
        }
        let offset = offsets[at];
        match formats.last_mut() {
            Some(Delta::Retain(length, Some(run))) if cursor == offset && **run == diff => {
                *length += 1
            }
            _ => {
                if offset > cursor {
                    formats.push(Delta::Retain(offset - cursor, None));
                }
                formats.push(Delta::Retain(1, Some(Box::new(diff))));
            }
        }
        cursor = offset + 1;
    }
    let pairs: Vec<(usize, usize)> = kept
        .filter_map(
            |(at, wanted)| match (&before.slots[at], &target.slots[wanted]) {
                (Slot::Line(line), Wanted::Line(given)) => Some((*line, *given)),
                _ => None,
            },
        )
        .collect();
    let ids = Ids::of(txn, client, containers, &before, &target, &pairs);
    let mut fold = Fold {
        records: ids.records(txn, containers, &before, &target),
        attributes: Vec::new(),
        formats,
        after: Vec::new(),
        middle: Vec::new(),
        placed: Vec::new(),
        before: Vec::new(),
    };
    let boundary = |wanted: &WantedLine| {
        let mut attributes = wanted.attributes.clone();
        attributes.insert("path", ids.path(&wanted.frames));
        attributes
    };
    let mut written = vec![false; before.lines.len()];
    for &(line, wanted) in &pairs {
        let (had, given) = (&before.lines[line], &target.lines[wanted]);
        let Some(element) = &had.boundary else {
            continue;
        };
        for (name, value) in changes(had, given, &before, &ids) {
            fold.attributes.push((element.clone(), name, value));
            written[line] = true;
        }
    }
    let span = |line: usize| {
        let next = before.lines.get(line + 1).map_or(have, |next| next.slot);
        (before.lines[line].slot, next)
    };
    let (low, high) = (start, have - end);
    let edited = low < high || start < want - end;
    for &(line, wanted) in &pairs {
        let (had, given) = (&before.lines[line], &target.lines[wanted]);
        if had.boundary.is_some() {
            continue;
        }
        let (mut from, mut to) = span(line);
        if let Some(owner) = had.owner {
            let (owner_from, owner_to) = span(owner);
            (from, to) = (from.min(owner_from), to.max(owner_to));
        }
        let given_again = had.owner.is_some_and(|owner| written[owner])
            || (edited && low <= to && high >= from)
            || (touched.0 < to && touched.1 >= from)
            || !changes(had, given, &before, &ids).is_empty();
        if given_again {
            let promoted = (offsets[had.slot], boundary(given));
            match had.slot < start {
                true => fold.before.push(promoted),
                false => fold.after.push(promoted),
            }
        }
    }
    fold.before.reverse();
    fold.after.reverse();
    let (from, to) = (offsets[start], offsets[have - end]);
    let middle = &target.slots[start..want - end];
    let places_items = middle.iter().any(|slot| !matches!(slot, Wanted::Unit(..)));
    if from > 0 {
        fold.middle.push(Delta::Retain(from, None));
    }
    if to > from {
        fold.middle.push(Delta::Deleted(to - from));
    }
    visit(middle.len());
    let mut in_force = match places_items {
        true => formatting_at(txn, sequence, from, false),
        false => Attrs::new(),
    };
    for (name, value) in last.into_iter().flatten() {
        match value {
            Any::Null => in_force.remove(&name),
            value => in_force.insert(name, value),
        };
    }
    let placed = places_items
        && (!in_force.is_empty()
            || middle.iter().chain(target.slots.get(want - end)).any(
                |slot| matches!(slot, Wanted::Unit(_, marks) if !target.marks[*marks].is_empty()),
            )
            || (to > from && !formatting_at(txn, sequence, to, true).is_empty()));
    let (mut at, mut position, mut retained) = (0, from, 0);
    while at < middle.len() {
        let piece = match &middle[at] {
            Wanted::Unit(_, marks) => {
                let mut units = Vec::new();
                while let Some(Wanted::Unit(unit, _)) = middle
                    .get(at)
                    .filter(|slot| matches!(slot, Wanted::Unit(_, other) if other == marks))
                {
                    units.push(*unit);
                    at += 1;
                }
                position += units.len() as u32;
                let letters = String::from_utf16(&units).map_err(|_| refused())?;
                in_force = target.marks[*marks].clone();
                let marks = Box::new(in_force.clone());
                fold.middle
                    .push(Delta::Inserted(Piece::Letters(letters), Some(marks)));
                continue;
            }
            Wanted::Inline(item) => {
                let (tag, attributes) = target.inline[*item].clone();
                Piece::Element { tag, attributes }
            }
            Wanted::Line(line) => Piece::Element {
                tag: BOUNDARY,
                attributes: boundary(&target.lines[*line]),
            },
        };
        match placed {
            true => {
                if position > retained {
                    fold.placed.push(Delta::Retain(position - retained, None));
                }
                let formatting = Some(Box::new(in_force.clone()));
                fold.placed.push(Delta::Inserted(piece, formatting));
                retained = position + 1;
            }
            false => fold.middle.push(Delta::Inserted(piece, None)),
        }
        (at, position) = (at + 1, position + 1);
    }
    Ok(fold)
}

/// The formatting in force after `offset` units. With `standing`, it also
/// takes the formatting items that stand right after them.
fn formatting_at<T: ReadTxn>(
    txn: &T,
    sequence: &yrs::TextRef,
    offset: u32,
    standing: bool,
) -> Attrs {
    let (mut attrs, mut passed) = (Attrs::new(), 0_u32);
    let _ = sequence.try_visit_items(txn, |item| {
        if passed >= offset && !(standing && matches!(item, TextItem::Format(..))) {
            return Err(());
        }
        match item {
            TextItem::Letters(text) => passed += text.encode_utf16().count() as u32,
            TextItem::Format(key, Any::Null) => drop(attrs.remove(key)),
            TextItem::Format(key, value) => drop(attrs.insert(Arc::from(key), value.clone())),
            TextItem::Embed(_) | TextItem::Other => passed += 1,
        }
        Ok(())
    });
    attrs
}

fn changes(had: &Line, given: &WantedLine, before: &Trace, ids: &Ids) -> Vec<(&'static str, Any)> {
    let retyped = had.tag != given.tag;
    let ids_had = had
        .frames
        .iter()
        .map(|frame| before.frames[*frame].id.as_str());
    let moved = !ids_had.eq(given.frames.iter().map(|frame| ids.ids[*frame].as_str()));
    let mut changes = Vec::new();
    for (name, value) in &given.attributes {
        let changed = match *name {
            "type" => retyped,
            "path" => moved,
            _ if retyped => match &had.boundary {
                Some(element) => body_sequence::stored_under(element, name).as_ref() != Some(value),
                None => true,
            },
            _ => had.attributes.get(name) != Some(value),
        };
        if changed {
            let value = match *name {
                "path" => ids.path(&given.frames),
                _ => value.clone(),
            };
            changes.push((*name, value));
        }
    }
    changes
}

struct Ids {
    ids: Vec<String>,
    kept: Vec<Option<usize>>,
    origin: Vec<Option<usize>>,
}

impl Ids {
    fn of<T: ReadTxn>(
        txn: &T,
        client: yrs::ClientID,
        containers: &MapRef,
        before: &Trace,
        target: &Target,
        pairs: &[(usize, usize)],
    ) -> Ids {
        let mut kept: Vec<Option<usize>> = vec![None; target.frames.len()];
        for &(line, wanted) in pairs {
            let (had, given) = (&before.lines[line].frames, &target.lines[wanted].frames);
            let (mut at, mut to) = (0, 0);
            while let (Some(&frame), Some(&wanted)) = (had.get(at), given.get(to)) {
                let kind = (before.frames[frame].kind, target.frames[wanted].kind);
                let family = body_sequence_writer::same_family(kind.0, kind.1);
                let (added, removed) = (given.len() - to, had.len() - at);
                match kept[wanted] {
                    Some(_) if family => {}
                    None if family => kept[wanted] = Some(frame),
                    _ if !family && added > removed => {
                        to += 1;
                        continue;
                    }
                    _ if !family && removed > added => {
                        at += 1;
                        continue;
                    }
                    _ => break,
                }
                (at, to) = (at + 1, to + 1);
            }
        }
        let origin = kept.clone();
        let mut used = BTreeSet::new();
        for frame in &mut kept {
            if frame.is_some_and(|frame| !used.insert(frame)) {
                *frame = None;
            }
        }
        let changed = |wanted: usize| match kept[wanted] {
            None => true,
            Some(frame) => {
                let (had, given) = (&before.frames[frame], &target.frames[wanted]);
                let differs = |(name, value): &(String, Any)| {
                    had.attributes
                        .get(name.as_str())
                        .is_some_and(|had| had != value)
                };
                had.kind != given.kind || given.records.iter().any(differs)
            }
        };
        let mut sharing: HashMap<&str, usize> = HashMap::new();
        for frame in kept.iter().flatten() {
            *sharing
                .entry(before.frames[*frame].id.as_str())
                .or_default() += 1;
        }
        let shared: Vec<bool> = (0..kept.len())
            .map(|wanted| {
                kept[wanted].is_some_and(|frame| sharing[before.frames[frame].id.as_str()] > 1)
                    && changed(wanted)
            })
            .collect();
        for (wanted, shared) in shared.into_iter().enumerate() {
            if shared {
                kept[wanted] = None;
            }
        }
        let id = |kept: &[Option<usize>], wanted: usize| {
            kept[wanted].map(|frame| before.frames[frame].id.as_str())
        };
        for pair in target.lines.windows(2) {
            let (above, below) = (&pair[0].frames, &pair[1].frames);
            let shared = above.iter().zip(below).take_while(|(a, b)| a == b).count();
            if let (Some(&above), Some(&below)) = (above.get(shared), below.get(shared)) {
                if id(&kept, above).is_some() && id(&kept, above) == id(&kept, below) {
                    kept[below] = None;
                }
            }
        }
        for line in &target.lines {
            for (depth, &inner) in line.frames.iter().enumerate() {
                let outer = &line.frames[..depth];
                let twice = |held| outer.iter().any(|&outer| id(&kept, outer) == Some(held));
                if id(&kept, inner).is_some_and(twice) {
                    kept[inner] = None;
                }
            }
        }
        let clock = txn.state_vector().get(&client);
        let mut counter = 0_u32;
        let mut fresh = || loop {
            counter += 1;
            let seed = format!("{client}:{clock}:{counter}");
            let id = crate::hex_sha256(seed.as_bytes())[..FRESH_ID_LETTERS].to_owned();
            if !containers.contains_key(txn, &id) {
                return id;
            }
        };
        let ids = (0..kept.len())
            .map(|wanted| match id(&kept, wanted) {
                Some(id) => id.to_owned(),
                None => fresh(),
            })
            .collect();
        Ids { ids, kept, origin }
    }

    fn path(&self, frames: &[usize]) -> Any {
        let ids: Vec<Any> = frames
            .iter()
            .map(|frame| Any::from(self.ids[*frame].as_str()))
            .collect();
        Any::from(ids)
    }

    fn records<T: ReadTxn>(
        &self,
        txn: &T,
        containers: &MapRef,
        before: &Trace,
        target: &Target,
    ) -> Vec<(String, Any)> {
        let mut records = Vec::new();
        let stored = |key: &str| match containers.get(txn, key) {
            Some(Out::Any(value)) => Some(value),
            _ => None,
        };
        for (wanted, frame) in target.frames.iter().enumerate() {
            let id = &self.ids[wanted];
            let kept = self.kept[wanted].is_some();
            let copied = self.origin[wanted]
                .filter(|_| !kept)
                .map(|frame| before.frames[frame].id.as_str());
            let shown = body_sequence_writer::stored(frame.kind, |_| None);
            let kind = (id.clone(), true, Any::from(frame.kind));
            let named = frame.records.iter().map(|(name, given)| {
                let shown = shown.contains_key(name.as_str());
                let value = match copied {
                    Some(copied) if !shown => stored(&format!("{copied}.{name}")),
                    _ => None,
                };
                (
                    format!("{id}.{name}"),
                    shown,
                    value.unwrap_or_else(|| given.clone()),
                )
            });
            for (key, shown, value) in std::iter::once(kind).chain(named) {
                if !kept || (shown && stored(&key).as_ref() != Some(&value)) {
                    records.push((key, value));
                }
            }
        }
        records
    }
}

impl Fold {
    pub(super) fn write(
        self,
        txn: &mut yrs::TransactionMut,
        sequence: &yrs::TextRef,
        containers: &MapRef,
    ) {
        for (key, value) in self.records {
            containers.insert(txn, key, value);
        }
        for (element, name, value) in self.attributes {
            element.insert_attribute(txn, name, value);
        }
        if !self.formats.is_empty() {
            sequence.apply_delta(txn, self.formats);
        }
        let promote = |txn: &mut yrs::TransactionMut, (offset, attributes): (u32, Stored)| {
            let element =
                sequence.insert_embed(txn, offset, yrs::XmlElementPrelim::empty(BOUNDARY));
            for (name, value) in attributes {
                element.insert_attribute(txn, name, value);
            }
        };
        for promoted in self.after {
            promote(txn, promoted);
        }
        if self
            .middle
            .iter()
            .any(|delta| !matches!(delta, Delta::Retain(..)))
        {
            sequence.apply_delta(txn, self.middle);
        }
        if !self.placed.is_empty() {
            sequence.apply_delta(txn, self.placed);
        }
        for promoted in self.before {
            promote(txn, promoted);
        }
    }
}

pub(super) enum Written {
    New(NewBody),
    Folded(Fold),
}

impl Written {
    pub(super) fn write(
        self,
        txn: &mut yrs::TransactionMut,
        sequence: &yrs::TextRef,
        containers: &MapRef,
    ) {
        match self {
            Written::New(body) => body_sequence_writer::write(txn, sequence, containers, body),
            Written::Folded(fold) => fold.write(txn, sequence, containers),
        }
    }
}

/// What a new note of `read` reads as, where format 2 holds `read` only
/// as the nearest reading it can hold.
pub(super) fn nearest_reading(
    read: &[MarkdownNode],
) -> ProjectionResult<Option<Vec<MarkdownNode>>> {
    let Some(body) = body_sequence_writer::new_body(read) else {
        return Ok(None);
    };
    let scratch = Ydoc::wire();
    let sequence = scratch.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = scratch.doc.get_or_insert_map(ROOT_CONTAINERS);
    body_sequence_writer::write(
        &mut scratch.doc.transact_mut(),
        &sequence,
        &containers,
        body,
    );
    let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
    let txn = scratch.doc.transact();
    body_sequence::blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes).map(Some)
}
