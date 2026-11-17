//! A folder's access rule, read from the `access.yaml` inside it.
//!
//! The twin of `packages/security-contract/src/accessRules.ts`. Both read
//! `accessRules.vectors.json` in their tests, so a rule means the same thing
//! to the engine that publishes it and the relay that enforces it. The engine
//! needs the parser and the narrowing check to order rule changes before the
//! files they cover; the relay owns evaluation.

use std::collections::{BTreeMap, BTreeSet};

use crate::floor::path_collision_key;

pub const ACCESS_RULE_FILE: &str = "access.yaml";
pub const ACCESS_RULE_MAX_BYTES: usize = 64 * 1024;
pub const ACCESS_RULE_MAX_PEOPLE: usize = 1_000;
const MAX_EMAIL_UTF16_UNITS: usize = 320;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    View,
    Comment,
    Edit,
}

impl Level {
    /// The word a rule file spells this level with.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Comment => "comment",
            Self::Edit => "edit",
        }
    }

    fn parse(word: &str) -> Option<Self> {
        match word {
            "view" => Some(Self::View),
            "comment" => Some(Self::Comment),
            "edit" => Some(Self::Edit),
            _ => None,
        }
    }
}

/// `members` is the level for a member no person entry names; `None` leaves
/// them out, which hides the folder. `people` is keyed by normalized email.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AccessRule {
    pub members: Option<Level>,
    pub people: BTreeMap<String, Level>,
}

fn last_segment_key(path: &str) -> String {
    path_collision_key(path.rsplit('/').next().unwrap_or(path))
}

/// Whether this file is a folder's rule, however the filesystem spells it.
pub fn is_access_rule_path(path: &str) -> bool {
    last_segment_key(path) == ACCESS_RULE_FILE
}

/// Whether this file is a rule or an editor's copy of one.
pub fn is_access_rule_related_path(path: &str) -> bool {
    last_segment_key(path).contains(ACCESS_RULE_FILE)
}

/// The folder a rule file belongs to: "" for the workspace root.
pub fn access_rule_folder(path: &str) -> &str {
    path.rfind('/').map_or("", |slash| &path[..slash])
}

// JavaScript's `\s` and `trim()` set, so both twins split the same way.
const JS_SPACES: &[char] = &[
    '\t', '\n', '\u{0B}', '\u{0C}', '\r', ' ', '\u{A0}', '\u{1680}', '\u{2028}', '\u{2029}',
    '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
];

fn is_js_space(c: char) -> bool {
    JS_SPACES.contains(&c) || ('\u{2000}'..='\u{200A}').contains(&c)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

// YAML separates tokens with spaces and tabs only; any other space belongs to
// the scalar it sits in, so a no-break space can't pass for one.
fn is_yaml_space(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// A line holding only a comment, or nothing.
fn line_skipped(raw: &str) -> bool {
    let rest = raw.trim_start_matches(is_yaml_space);
    rest.is_empty() || rest.starts_with('#')
}

/// What may follow a value: nothing, or a comment after at least one space.
fn line_end(rest: &str) -> bool {
    let after = rest.trim_start_matches(is_yaml_space);
    after.is_empty() || (after.starts_with('#') && after.len() < rest.len())
}

/// The one form rule keys and account emails are compared in.
pub fn normalize_rule_email(email: &str) -> String {
    js_trim(email).to_lowercase()
}

fn looks_like_email(value: &str) -> bool {
    let Some(at) = value.find('@') else {
        return false;
    };
    value.encode_utf16().count() <= MAX_EMAIL_UTF16_UNITS
        && at > 0
        && value.rfind('@') == Some(at)
        && at + 1 < value.len()
        && !value.chars().any(is_js_space)
}

/// A scalar: plain, or quoted with no escapes. The scalar and the rest of the line.
fn read_scalar(text: &str, stop_at_colon: bool) -> Option<(&str, &str)> {
    if let Some(quote) = text.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let end = text[1..].find(quote)? + 1;
        let value = &text[1..end];
        if quote == '"' && value.contains('\\') {
            return None;
        }
        return Some((value, &text[end + 1..]));
    }
    let mut end = text.len();
    let mut previous: Option<char> = None;
    for (index, c) in text.char_indices() {
        if (stop_at_colon && c == ':') || (c == '#' && previous.is_none_or(is_yaml_space)) {
            end = index;
            break;
        }
        previous = Some(c);
    }
    let value = text[..end].trim_end_matches(is_yaml_space);
    let first = value.chars().next()?;
    if "&*!|>%@`{[]},?-".contains(first) {
        return None;
    }
    Some((value, &text[value.len()..]))
}

enum Line<'a> {
    Skip,
    Entry {
        indent: usize,
        key: &'a str,
        value: Option<&'a str>,
    },
}

fn read_line(raw: &str) -> Option<Line<'_>> {
    if line_skipped(raw) {
        return Some(Line::Skip);
    }
    let body = raw.trim_start_matches(is_yaml_space);
    let indentation = &raw[..raw.len() - body.len()];
    if indentation.contains('\t') {
        return None;
    }
    let (key, rest) = read_scalar(body, true)?;
    let after_colon = rest.strip_prefix(':')?;
    if after_colon
        .chars()
        .next()
        .is_some_and(|c| !is_yaml_space(c))
    {
        return None;
    }
    let indent = indentation.len();
    if line_end(after_colon) {
        return Some(Line::Entry {
            indent,
            key,
            value: None,
        });
    }
    let (value, rest) = read_scalar(after_colon.trim_start_matches(is_yaml_space), false)?;
    if !line_end(rest) {
        return None;
    }
    Some(Line::Entry {
        indent,
        key,
        value: Some(value),
    })
}

/// Reads a rule, or `None` when it can't be read. An unreadable rule hides its
/// folder, so anything outside this small format is refused, not guessed at.
pub fn parse_access_rule(text: &str) -> Option<AccessRule> {
    if text.len() > ACCESS_RULE_MAX_BYTES || text.contains('\0') {
        return None;
    }
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut rule = AccessRule::default();
    let (mut saw_members, mut saw_people, mut in_people) = (false, false, false);
    let mut people_indent = None;
    for raw in text.split_inclusive('\n') {
        // A CR ends a line only before an LF, as the relay's `\r?\n` split reads it.
        let raw = match raw.strip_suffix('\n') {
            Some(line) => line.strip_suffix('\r').unwrap_or(line),
            None => raw,
        };
        let Line::Entry { indent, key, value } = read_line(raw)? else {
            continue;
        };
        if indent == 0 {
            in_people = false;
            match (key, value) {
                ("members", Some(word)) if !saw_members => {
                    rule.members = Some(Level::parse(word)?);
                    saw_members = true;
                }
                ("people", None) if !saw_people => {
                    saw_people = true;
                    in_people = true;
                }
                _ => return None,
            }
            continue;
        }
        if !in_people || *people_indent.get_or_insert(indent) != indent {
            return None;
        }
        let level = Level::parse(value?)?;
        if !looks_like_email(key) {
            return None;
        }
        let email = normalize_rule_email(key);
        if rule.people.contains_key(&email) || rule.people.len() >= ACCESS_RULE_MAX_PEOPLE {
            return None;
        }
        rule.people.insert(email, level);
    }
    Some(rule)
}

fn lower(a: Option<Level>, b: Option<Level>) -> Option<Level> {
    Some(a?.min(b?))
}

/// The level `rule` gives the person with this normalized email.
pub fn level_for_email(rule: &AccessRule, email: &str) -> Option<Level> {
    rule.people.get(email).copied().or(rule.members)
}

fn emails<'a>(a: &'a AccessRule, b: &'a AccessRule) -> BTreeSet<&'a str> {
    a.people
        .keys()
        .chain(b.people.keys())
        .map(String::as_str)
        .collect()
}

/// The rule that gives everyone the lower of what `a` and `b` give them.
pub fn lower_rule(a: &AccessRule, b: &AccessRule) -> AccessRule {
    let members = lower(a.members, b.members);
    let people = emails(a, b)
        .into_iter()
        .filter_map(|email| {
            let level = lower(level_for_email(a, email), level_for_email(b, email))?;
            (Some(level) != members).then(|| (email.to_owned(), level))
        })
        .collect();
    AccessRule { members, people }
}

/// Whether `next` gives nobody more than `previous` does.
pub fn rule_only_narrows(previous: &AccessRule, next: &AccessRule) -> bool {
    lower(previous.members, next.members) == next.members
        && emails(previous, next).into_iter().all(|email| {
            let after = level_for_email(next, email);
            lower(level_for_email(previous, email), after) == after
        })
}

/// What members could reach at a folder before a new rule there.
#[derive(Clone, Copy, Debug)]
pub enum ReachBefore<'a> {
    /// The rule last committed at this folder; `None` when it was unreadable.
    Own(Option<&'a AccessRule>),
    /// No rule was committed here; this is the nearest ancestor's, `None`
    /// when that one was unreadable.
    Inherited(Option<&'a AccessRule>),
    /// No rule above either: members hold their workspace level, which the
    /// engine does not know.
    WorkspaceLevel,
}

/// Whether `next` (`None` when unreadable) gives nobody more than they could
/// reach before. An unreadable rule hides its folder, so it always narrows.
pub fn rule_change_narrows(before: ReachBefore<'_>, next: Option<&AccessRule>) -> bool {
    let Some(next) = next else {
        return true;
    };
    match before {
        ReachBefore::Own(None) => false,
        ReachBefore::Own(Some(previous)) => rule_only_narrows(previous, next),
        // Whatever an unreadable ancestor hides stays hidden below it.
        ReachBefore::Inherited(None) => true,
        ReachBefore::Inherited(Some(above)) => {
            let fits = |before: Option<Level>, after: Option<Level>| {
                before.is_none() || lower(before, after) == after
            };
            fits(above.members, next.members)
                && emails(above, next)
                    .into_iter()
                    .all(|email| fits(level_for_email(above, email), level_for_email(next, email)))
        }
        ReachBefore::WorkspaceLevel => next
            .members
            .iter()
            .chain(next.people.values())
            .all(|level| *level == Level::View),
    }
}

/// Where a change at `path` goes in an operation that changes many paths:
/// rule writes first, outer folders before inner ones; rule deletes last,
/// inner folders before outer ones; every other path between, in its order.
/// Sorting by path alone is wrong: `a/Z.md` sorts before `a/access.yaml`.
pub fn access_rule_rank(path: &str, deletes: bool) -> (u8, i64) {
    if !is_access_rule_path(path) {
        return (1, 0);
    }
    let depth = i64::try_from(path.matches('/').count()).unwrap_or(i64::MAX);
    if deletes { (2, -depth) } else { (0, depth) }
}

/// Put the changes of an operation that changes many paths in the order
/// [`access_rule_rank`] gives. The sort is stable, so changes of one rank keep
/// the order they came in. `change` names a change's path and whether it
/// deletes that path.
pub fn sort_rule_changes<T>(changes: &mut [T], change: impl Fn(&T) -> (&str, bool)) {
    changes.sort_by_key(|item| {
        let (path, deletes) = change(item);
        access_rule_rank(path, deletes)
    });
}

/// Whether `path` is one of `folder`'s rule files, as the relay reads them:
/// a file in exactly that folder whose name folds to `access.yaml`. Two such
/// files are one unreadable rule.
pub fn is_rule_of(path: &str, folder: &str) -> bool {
    is_access_rule_path(path) && access_rule_folder(path) == folder
}

/// What a member can reach at one point: hidden, their workspace member
/// level, which the engine does not know, or a rule's level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reach {
    Hidden,
    Workspace,
    Level(Level),
}

impl Reach {
    /// Whether this gives nobody more than `bound`. A workspace member level
    /// is at least View and at most Edit.
    fn within(self, bound: Self) -> bool {
        match (self, bound) {
            (Self::Hidden, _) | (Self::Workspace, Self::Workspace) => true,
            (Self::Workspace, Self::Level(level)) => level == Level::Edit,
            (Self::Level(level), Self::Workspace) => level == Level::View,
            (Self::Level(level), Self::Level(bound)) => level <= bound,
            (_, Self::Hidden) => false,
        }
    }
}

/// Rule files by path, each borrowed from where it was read; `None` is one
/// that can't be read.
type RuleFiles<'a> = BTreeMap<&'a str, Option<&'a AccessRule>>;

/// Each ruled folder's rule. Two files in one folder are one unreadable rule.
fn folder_rules<'a>(files: &RuleFiles<'a>) -> BTreeMap<&'a str, Option<&'a AccessRule>> {
    let mut folders: BTreeMap<&'a str, Option<&'a AccessRule>> = BTreeMap::new();
    for (&path, &rule) in files {
        folders
            .entry(access_rule_folder(path))
            .and_modify(|twice| *twice = None)
            .or_insert(rule);
    }
    folders
}

/// What a member reaches in `folder`, as the relay's `folderLevel` reads it
/// when no two folders' names fold together: rules apply from the root down,
/// each replaces the level above, and one that leaves the member out hides
/// everything below. `email` is a person a rule names, or `None` for a member
/// none names. The engine refuses a merge order that relies on this where
/// folder names fold together.
fn reach_in(
    rules: &BTreeMap<&str, Option<&AccessRule>>,
    folder: &str,
    email: Option<&str>,
) -> Reach {
    let mut reach = Reach::Workspace;
    let chain = std::iter::once("").chain(
        folder
            .match_indices('/')
            .map(|(slash, _)| &folder[..slash])
            .chain((!folder.is_empty()).then_some(folder)),
    );
    for ancestor in chain {
        let Some(rule) = rules.get(ancestor) else {
            continue;
        };
        let level = rule.and_then(|rule| match email {
            Some(email) => level_for_email(rule, email),
            None => rule.members,
        });
        match level {
            Some(level) => reach = Reach::Level(level),
            None => return Reach::Hidden,
        }
    }
    reach
}

/// Whether `path` is `folder` or inside it. Every path is inside the root.
fn at_or_under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// A rule file a change of many paths writes, with its bytes, or deletes.
#[derive(Clone, Copy, Debug)]
pub enum RuleFileStep<'a> {
    Write(&'a str, &'a [u8]),
    Delete(&'a str),
}

fn parsed(bytes: &[u8]) -> Option<AccessRule> {
    std::str::from_utf8(bytes).ok().and_then(parse_access_rule)
}

/// One step with its rule read: `rule` is `Some` for a write, holding the
/// rule it writes, and `None` for a delete.
#[derive(Clone, Copy)]
struct Step<'a> {
    path: &'a str,
    folder: &'a str,
    rule: Option<Option<&'a AccessRule>>,
}

impl<'a> Step<'a> {
    fn apply(self, files: &mut RuleFiles<'a>) {
        match self.rule {
            Some(rule) => {
                files.insert(self.path, rule);
            }
            None => {
                files.remove(self.path);
            }
        }
    }
}

/// The rules before a change of many rule files, and what each member may
/// reach while it is made: no more than both the rules before and the rules
/// after give them, at the root and at every folder that holds a rule before
/// or after. Every other folder reaches what its nearest such folder above
/// it does.
struct Change<'a> {
    start: RuleFiles<'a>,
    /// Each point and person, with their reach before and after.
    bounds: Vec<(&'a str, Option<&'a str>, Reach, Reach)>,
    /// For each step, the bounds at or under its folder: the only ones it
    /// can move.
    affected: Vec<Vec<usize>>,
}

impl<'a> Change<'a> {
    fn new(start: RuleFiles<'a>, steps: &[Step<'a>]) -> Self {
        let mut end = start.clone();
        for step in steps {
            step.apply(&mut end);
        }
        let emails: BTreeSet<&'a str> = start
            .values()
            .chain(end.values())
            .copied()
            .flatten()
            .flat_map(|rule| rule.people.keys().map(String::as_str))
            .collect();
        let people: Vec<Option<&'a str>> = std::iter::once(None)
            .chain(emails.into_iter().map(Some))
            .collect();
        let points: BTreeSet<&'a str> = std::iter::once("")
            .chain(
                start
                    .keys()
                    .chain(end.keys())
                    .map(|&path| access_rule_folder(path)),
            )
            .collect();
        let (before, after) = (folder_rules(&start), folder_rules(&end));
        let mut bounds = Vec::with_capacity(points.len() * people.len());
        for &point in &points {
            for &email in &people {
                bounds.push((
                    point,
                    email,
                    reach_in(&before, point, email),
                    reach_in(&after, point, email),
                ));
            }
        }
        let affected = steps
            .iter()
            .map(|step| {
                bounds
                    .iter()
                    .enumerate()
                    .filter(|(_, (point, ..))| at_or_under(point, step.folder))
                    .map(|(index, _)| index)
                    .collect()
            })
            .collect();
        Self {
            start,
            bounds,
            affected,
        }
    }

    /// Whether `files`, which `step` made from a state within bounds, is
    /// still within them.
    fn safe_after(&self, files: &RuleFiles<'a>, step: usize) -> bool {
        let rules = folder_rules(files);
        self.affected[step].iter().all(|&index| {
            let (point, email, before, after) = self.bounds[index];
            let reach = reach_in(&rules, point, email);
            reach.within(before) || reach.within(after)
        })
    }
}

/// How many reach judgements the order search may make, over every state it
/// tries, before it stops. It runs on the engine's write thread.
const RULE_ORDER_WORK: usize = 2_000_000;

/// The search keeps the steps a phase has taken as the bits of one word.
/// Past this many in one group's phase, only the order given is tried.
const MAX_SEARCHED_RULE_STEPS: usize = 64;

/// What the search found for a change of many rule files. Each list holds
/// indexes into the writes, then into the deletes.
#[derive(Debug, PartialEq, Eq)]
pub enum RuleFileOrder {
    /// Write, then delete, in this order.
    Safe {
        writes: Vec<usize>,
        deletes: Vec<usize>,
    },
    /// No order of these steps keeps everyone within bounds.
    Widens {
        writes: Vec<usize>,
        deletes: Vec<usize>,
    },
    /// The search reached its work limit before it found an order of these
    /// steps. One may still exist.
    TooMany {
        writes: Vec<usize>,
        deletes: Vec<usize>,
    },
}

enum Found {
    Order(Vec<usize>),
    None,
    OutOfWork,
}

struct Search<'c, 'a> {
    change: &'c Change<'a>,
    steps: &'c [Step<'a>],
    work: usize,
}

impl<'a> Search<'_, 'a> {
    /// Takes the work of judging one state that `step` made from `files`.
    fn charge(&mut self, files: &RuleFiles<'a>, step: usize) -> bool {
        let cost = self.change.affected[step].len() + files.len() + 1;
        match self.work.checked_sub(cost) {
            Some(left) => {
                self.work = left;
                true
            }
            None => {
                self.work = 0;
                false
            }
        }
    }

    /// An order of `phase`, indexes into the steps, from `files`, in which
    /// every state is within bounds.
    fn phase(&mut self, files: &RuleFiles<'a>, phase: &[usize]) -> Found {
        if phase.len() > MAX_SEARCHED_RULE_STEPS {
            let mut files = files.clone();
            for &step in phase {
                if !self.charge(&files, step) {
                    return Found::OutOfWork;
                }
                self.steps[step].apply(&mut files);
                if !self.change.safe_after(&files, step) {
                    return Found::OutOfWork;
                }
            }
            return Found::Order(phase.to_vec());
        }
        let mut order = Vec::with_capacity(phase.len());
        let mut failed = BTreeSet::new();
        match self.search(files, 0, phase, &mut failed, &mut order) {
            Some(true) => Found::Order(order.into_iter().map(|slot| phase[slot]).collect()),
            Some(false) => Found::None,
            None => Found::OutOfWork,
        }
    }

    /// Depth first, trying the order given first. `None` when the work ran
    /// out before an answer.
    fn search(
        &mut self,
        files: &RuleFiles<'a>,
        done: u64,
        phase: &[usize],
        failed: &mut BTreeSet<u64>,
        order: &mut Vec<usize>,
    ) -> Option<bool> {
        if order.len() == phase.len() {
            return Some(true);
        }
        if failed.contains(&done) {
            return Some(false);
        }
        for (slot, &step) in phase.iter().enumerate() {
            if done & (1 << slot) != 0 {
                continue;
            }
            if !self.charge(files, step) {
                return None;
            }
            let mut next = files.clone();
            self.steps[step].apply(&mut next);
            if !self.change.safe_after(&next, step) {
                continue;
            }
            order.push(slot);
            if self.search(&next, done | (1 << slot), phase, failed, order)? {
                return Some(true);
            }
            order.pop();
        }
        failed.insert(done);
        Some(false)
    }
}

/// The steps in groups that can't affect each other: two steps share a group
/// when one's folder is at or under the other's. A folder's reach depends
/// only on the rules at and above it, so every folder is moved by one group
/// at most. Each group lists its steps in the order given.
fn independent_groups(steps: &[Step<'_>]) -> Vec<Vec<usize>> {
    fn root(parent: &mut [usize], mut index: usize) -> usize {
        while parent[index] != index {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        index
    }
    let mut parent: Vec<usize> = (0..steps.len()).collect();
    for a in 0..steps.len() {
        for b in a + 1..steps.len() {
            let (fa, fb) = (steps[a].folder, steps[b].folder);
            if at_or_under(fa, fb) || at_or_under(fb, fa) {
                let (ra, rb) = (root(&mut parent, a), root(&mut parent, b));
                parent[ra.max(rb)] = ra.min(rb);
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for index in 0..steps.len() {
        let group = root(&mut parent, index);
        groups.entry(group).or_default().push(index);
    }
    groups.into_values().collect()
}

/// Reads each rule once, and hands `run` the rules before the change and
/// each step with its rule.
fn with_steps<T>(
    before: &BTreeMap<String, Vec<u8>>,
    steps: &[RuleFileStep<'_>],
    run: impl for<'a> FnOnce(RuleFiles<'a>, Vec<Step<'a>>) -> T,
) -> T {
    let before: Vec<(&str, Option<AccessRule>)> = before
        .iter()
        .map(|(path, bytes)| (path.as_str(), parsed(bytes)))
        .collect();
    let written: Vec<Option<AccessRule>> = steps
        .iter()
        .map(|step| match step {
            RuleFileStep::Write(_, bytes) => parsed(bytes),
            RuleFileStep::Delete(_) => None,
        })
        .collect();
    let start = before
        .iter()
        .map(|(path, rule)| (*path, rule.as_ref()))
        .collect();
    let steps = steps
        .iter()
        .zip(&written)
        .map(|(step, rule)| match *step {
            RuleFileStep::Write(path, _) => Step {
                path,
                folder: access_rule_folder(path),
                rule: Some(rule.as_ref()),
            },
            RuleFileStep::Delete(path) => Step {
                path,
                folder: access_rule_folder(path),
                rule: None,
            },
        })
        .collect();
    run(start, steps)
}

/// An order for writing, then deleting, many rule files one at a time, in
/// which no step gives any member more anywhere than both the rules before
/// and the rules after give them. Each phase tries the order given first.
///
/// `before` is every rule file before the change. Files merge between the
/// two phases, so the state after the writes must stay within bounds too.
/// Steps in folders apart from each other are ordered apart, so unrelated
/// rules neither share nor use up one search.
pub fn safe_rule_file_order(
    before: &BTreeMap<String, Vec<u8>>,
    writes: &[RuleFileStep<'_>],
    deletes: &[RuleFileStep<'_>],
) -> RuleFileOrder {
    let all: Vec<RuleFileStep<'_>> = writes.iter().chain(deletes).copied().collect();
    let split = |group: &[usize]| -> (Vec<usize>, Vec<usize>) {
        let (in_writes, in_deletes): (Vec<usize>, Vec<usize>) =
            group.iter().partition(|&&step| step < writes.len());
        (
            in_writes,
            in_deletes
                .into_iter()
                .map(|step| step - writes.len())
                .collect(),
        )
    };
    with_steps(before, &all, |start, steps| {
        let change = Change::new(start, &steps);
        let mut search = Search {
            change: &change,
            steps: &steps,
            work: RULE_ORDER_WORK,
        };
        let (mut write_order, mut delete_order) = (Vec::new(), Vec::new());
        for group in independent_groups(&steps) {
            let (group_writes, group_deletes): (Vec<usize>, Vec<usize>) =
                group.iter().partition(|&&step| step < writes.len());
            // A group moves only its own folders, so it starts from the
            // rules before the change, whatever the other groups did.
            let mut files = change.start.clone();
            let written = match search.phase(&files, &group_writes) {
                Found::Order(order) => order,
                Found::None => {
                    let (writes, deletes) = split(&group);
                    return RuleFileOrder::Widens { writes, deletes };
                }
                Found::OutOfWork => {
                    let (writes, deletes) = split(&group);
                    return RuleFileOrder::TooMany { writes, deletes };
                }
            };
            for &step in &group_writes {
                steps[step].apply(&mut files);
            }
            let deleted = match search.phase(&files, &group_deletes) {
                Found::Order(order) => order,
                Found::None => {
                    let (writes, deletes) = split(&group);
                    return RuleFileOrder::Widens { writes, deletes };
                }
                Found::OutOfWork => {
                    let (writes, deletes) = split(&group);
                    return RuleFileOrder::TooMany { writes, deletes };
                }
            };
            write_order.extend(written);
            delete_order.extend(deleted.into_iter().map(|step| step - writes.len()));
        }
        RuleFileOrder::Safe {
            writes: write_order,
            deletes: delete_order,
        }
    })
}

/// Whether making `steps` one at a time, in this order, from `before`, keeps
/// everyone within what the rules before and after give them after each one.
pub fn rule_file_order_is_safe(
    before: &BTreeMap<String, Vec<u8>>,
    steps: &[RuleFileStep<'_>],
) -> bool {
    with_steps(before, steps, |start, steps| {
        let change = Change::new(start, &steps);
        let mut files = change.start.clone();
        steps.iter().enumerate().all(|(index, step)| {
            step.apply(&mut files);
            change.safe_after(&files, index)
        })
    })
}

/// The relay's `folderLevel` (`packages/security-contract/src/accessRules.ts`),
/// written out again so tests can judge the engine's merge order with
/// something other than the planner. The shared vectors' `reach` cases pin
/// it to the relay.
#[cfg(any(test, feature = "test-support"))]
pub mod relay_reach {
    use std::collections::{BTreeMap, BTreeSet};

    use super::{AccessRule, Level, access_rule_folder, level_for_email, parse_access_rule};
    use crate::floor::path_collision_key;

    /// Each ruled folder and its rule, from rule files by path. Two files in
    /// one folder, or one that doesn't parse, are a rule that can't be read.
    pub fn rules_by_folder(files: &BTreeMap<String, String>) -> Vec<(String, Option<AccessRule>)> {
        let mut folders: BTreeMap<&str, Option<AccessRule>> = BTreeMap::new();
        for (path, text) in files {
            folders
                .entry(access_rule_folder(path))
                .and_modify(|twice| *twice = None)
                .or_insert_with(|| parse_access_rule(text));
        }
        folders
            .into_iter()
            .map(|(folder, rule)| (folder.to_owned(), rule))
            .collect()
    }

    /// The level a member at `member` level, with this rule email or none,
    /// has in `folder`; `None` when it is hidden from them.
    pub fn folder_level(
        rules: &[(String, Option<AccessRule>)],
        folder: &str,
        email: Option<&str>,
        member: Level,
    ) -> Option<Level> {
        let rule_level = |rule: &Option<AccessRule>| {
            rule.as_ref().and_then(|rule| match email {
                Some(email) => level_for_email(rule, email),
                None => rule.members,
            })
        };
        let mut chain = vec![""];
        chain.extend(folder.match_indices('/').map(|(slash, _)| &folder[..slash]));
        if !folder.is_empty() {
            chain.push(folder);
        }
        let mut level = Some(member);
        for ancestor in chain {
            let key = path_collision_key(ancestor);
            let mut twins = rules
                .iter()
                .filter(|(ruled, _)| path_collision_key(ruled) == key)
                .peekable();
            if twins.peek().is_none() {
                continue;
            }
            if twins.any(|(_, rule)| rule_level(rule).is_none()) {
                return None;
            }
            if let Some((_, own)) = rules.iter().find(|(ruled, _)| ruled == ancestor) {
                level = rule_level(own);
            }
        }
        level
    }

    /// The first place where a member reaches more in `state` than both
    /// `before` and `after` give them, at any member level: at the root, in
    /// each folder a state holds a rule in, and in `folders`. `None` when
    /// there is none.
    pub fn widening(
        before: &BTreeMap<String, String>,
        state: &BTreeMap<String, String>,
        after: &BTreeMap<String, String>,
        folders: &[&str],
    ) -> Option<String> {
        let [before, state, after] = [before, state, after].map(rules_by_folder);
        let emails: BTreeSet<&str> = [&before, &state, &after]
            .into_iter()
            .flatten()
            .filter_map(|(_, rule)| rule.as_ref())
            .flat_map(|rule| rule.people.keys().map(String::as_str))
            .collect();
        let points: BTreeSet<&str> = [&before, &state, &after]
            .into_iter()
            .flatten()
            .map(|(folder, _)| folder.as_str())
            .chain(folders.iter().copied())
            .chain([""])
            .collect();
        for member in [Level::View, Level::Comment, Level::Edit] {
            for &point in &points {
                for email in std::iter::once(None).chain(emails.iter().copied().map(Some)) {
                    let at = |rules: &[(String, Option<AccessRule>)]| {
                        folder_level(rules, point, email, member)
                    };
                    let reach = at(&state[..]);
                    if reach > at(&before[..]) && reach > at(&after[..]) {
                        return Some(format!(
                            "{email:?} at member level {member:?} reaches {reach:?} in {point:?}, \
                             before {:?}, after {:?}",
                            at(&before[..]),
                            at(&after[..])
                        ));
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct VectorRule {
        members: Option<String>,
        people: BTreeMap<String, String>,
    }

    #[derive(serde::Deserialize)]
    struct Parsed {
        name: String,
        text: String,
        rule: Option<VectorRule>,
    }

    #[derive(serde::Deserialize)]
    struct Narrowing {
        name: String,
        before: String,
        after: String,
        narrows: bool,
        lower: VectorRule,
    }

    /// What a member reaches in `folder` under `rules`, by folder; a null
    /// rule can't be read. `level` is "member" for the member's own level, a
    /// level word, or null when the folder is hidden from them.
    #[derive(serde::Deserialize)]
    struct ReachCase {
        name: String,
        rules: BTreeMap<String, Option<String>>,
        folder: String,
        email: Option<String>,
        level: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        parsed: Vec<Parsed>,
        narrowing: Vec<Narrowing>,
        reach: Vec<ReachCase>,
    }

    fn level(word: &str) -> Level {
        Level::parse(word).expect("a level word")
    }

    fn expected(rule: VectorRule) -> AccessRule {
        AccessRule {
            members: rule.members.as_deref().map(level),
            people: rule
                .people
                .into_iter()
                .map(|(email, word)| (email, level(&word)))
                .collect(),
        }
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!(
            "../../../packages/security-contract/src/accessRules.vectors.json"
        ))
        .expect("shared access rule vectors")
    }

    #[test]
    fn parses_the_shared_vectors_as_the_relay_does() {
        for case in vectors().parsed {
            assert_eq!(
                parse_access_rule(&case.text),
                case.rule.map(expected),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn narrows_and_lowers_the_shared_vectors_as_the_relay_does() {
        for case in vectors().narrowing {
            let before = parse_access_rule(&case.before).expect("readable before");
            let after = parse_access_rule(&case.after).expect("readable after");
            assert_eq!(
                rule_only_narrows(&before, &after),
                case.narrows,
                "{}",
                case.name
            );
            assert_eq!(
                lower_rule(&before, &after),
                expected(case.lower),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn refuses_a_rule_over_the_size_cap() {
        let text = format!("members: view\n#{}\n", "x".repeat(ACCESS_RULE_MAX_BYTES));
        assert_eq!(parse_access_rule(&text), None);
    }

    fn rule(text: &str) -> AccessRule {
        parse_access_rule(text).expect("a readable rule")
    }

    #[test]
    fn judges_a_new_or_changed_rule_against_what_members_reached_before() {
        let view = rule("members: view\n");
        let edit = rule("members: edit\n");
        let sam_edit = rule("people:\n  sam@example.com: edit\n");
        let nobody = rule("");
        let cases = [
            (
                "unreadable hides",
                ReachBefore::Own(Some(&view)),
                None,
                true,
            ),
            (
                "own narrows",
                ReachBefore::Own(Some(&edit)),
                Some(&view),
                true,
            ),
            (
                "own widens",
                ReachBefore::Own(Some(&view)),
                Some(&edit),
                false,
            ),
            (
                "readable after unreadable",
                ReachBefore::Own(None),
                Some(&nobody),
                false,
            ),
            (
                "under a view rule",
                ReachBefore::Inherited(Some(&view)),
                Some(&edit),
                false,
            ),
            (
                "under an edit rule",
                ReachBefore::Inherited(Some(&edit)),
                Some(&view),
                true,
            ),
            // Sam alone could reach the ancestor; the rest were hidden there.
            (
                "under a rule that hides members",
                ReachBefore::Inherited(Some(&sam_edit)),
                Some(&edit),
                true,
            ),
            (
                "under an unreadable rule",
                ReachBefore::Inherited(None),
                Some(&edit),
                true,
            ),
            (
                "view for all",
                ReachBefore::WorkspaceLevel,
                Some(&view),
                true,
            ),
            (
                "names nobody",
                ReachBefore::WorkspaceLevel,
                Some(&nobody),
                true,
            ),
            (
                "edit for members",
                ReachBefore::WorkspaceLevel,
                Some(&edit),
                false,
            ),
            (
                "edit for sam",
                ReachBefore::WorkspaceLevel,
                Some(&sam_edit),
                false,
            ),
        ];
        for (name, before, next, narrows) in cases {
            assert_eq!(rule_change_narrows(before, next), narrows, "{name}");
        }
    }

    #[test]
    fn sorts_rule_writes_first_and_rule_deletes_last() {
        let mut writes = vec!["a/Z.md", "a/b/access.yaml", "a/ACCESS.yaml", "access.yaml"];
        sort_rule_changes(&mut writes, |path| (path, false));
        assert_eq!(
            writes,
            ["access.yaml", "a/ACCESS.yaml", "a/b/access.yaml", "a/Z.md"]
        );
        let mut deletes = vec!["access.yaml", "a/access.yaml", "a/b/Access.YAML", "a/Z.md"];
        sort_rule_changes(&mut deletes, |path| (path, true));
        assert_eq!(
            deletes,
            ["a/Z.md", "a/b/Access.YAML", "a/access.yaml", "access.yaml"]
        );
        // Other changes keep the order they came in.
        let mut mixed = vec![("b.md", true), ("a/access.yaml", false), ("a.md", false)];
        sort_rule_changes(&mut mixed, |(path, deletes)| (path, *deletes));
        assert_eq!(
            mixed,
            [("a/access.yaml", false), ("b.md", true), ("a.md", false)]
        );
    }

    #[test]
    fn finds_a_folders_rule_by_its_folded_name_in_exactly_that_folder() {
        assert!(is_rule_of("T/ACCESS.yaml", "T"));
        assert!(is_rule_of("T/Access.YAML", "T"));
        assert!(is_rule_of("ACCESS.yaml", ""));
        assert!(!is_rule_of("T/sub/access.yaml", "T"));
        assert!(!is_rule_of("t/access.yaml", "T"));
        assert!(!is_rule_of("T/access.yaml.tmp", "T"));
    }

    #[test]
    fn knows_a_rule_however_it_is_spelled_and_its_copies() {
        assert!(is_access_rule_path("a/ACCESS.yaml"));
        assert!(!is_access_rule_path("a/access.yaml~"));
        assert!(is_access_rule_related_path("a/#access.yaml#"));
        assert!(!is_access_rule_related_path("a/access.yml"));
        assert_eq!(access_rule_folder("a/b/access.yaml"), "a/b");
        assert_eq!(access_rule_folder("access.yaml"), "");
    }

    fn reach_rules(case: &ReachCase) -> Vec<(String, Option<AccessRule>)> {
        case.rules
            .iter()
            .map(|(folder, text)| {
                let rule = text
                    .as_deref()
                    .map(|text| parse_access_rule(text).expect("a readable vector rule"));
                (folder.clone(), rule)
            })
            .collect()
    }

    /// Whether two of the folders a case names fold to one name.
    fn has_twins(case: &ReachCase) -> bool {
        let folder = case.folder.as_str();
        let names: BTreeSet<&str> = case
            .rules
            .keys()
            .map(String::as_str)
            .chain(folder.match_indices('/').map(|(slash, _)| &folder[..slash]))
            .chain([folder])
            .collect();
        let keys: BTreeSet<String> = names.iter().map(|name| path_collision_key(name)).collect();
        keys.len() < names.len()
    }

    #[test]
    fn reaches_folders_in_the_shared_vectors_as_the_relay_does() {
        for case in vectors().reach {
            let rules = reach_rules(&case);
            for member in [Level::View, Level::Edit] {
                let expected = match case.level.as_deref() {
                    Some("member") => Some(member),
                    word => word.map(level),
                };
                assert_eq!(
                    relay_reach::folder_level(&rules, &case.folder, case.email.as_deref(), member),
                    expected,
                    "{} at {member:?}",
                    case.name
                );
            }
            // The planner's own reach agrees wherever no names fold together;
            // the engine refuses a merge order that would rely on it there.
            if has_twins(&case) {
                continue;
            }
            let refs: BTreeMap<&str, Option<&AccessRule>> = rules
                .iter()
                .map(|(folder, rule)| (folder.as_str(), rule.as_ref()))
                .collect();
            let expected = match case.level.as_deref() {
                Some("member") => Reach::Workspace,
                Some(word) => Reach::Level(level(word)),
                None => Reach::Hidden,
            };
            assert_eq!(
                reach_in(&refs, &case.folder, case.email.as_deref()),
                expected,
                "{}",
                case.name
            );
        }
    }

    fn rule_files(files: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        files
            .iter()
            .map(|(path, text)| {
                assert!(parse_access_rule(text).is_some(), "{path} reads");
                ((*path).to_owned(), text.as_bytes().to_vec())
            })
            .collect()
    }

    fn texts(files: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
        files
            .iter()
            .map(|(path, bytes)| {
                let text = String::from_utf8(bytes.clone()).expect("rule text");
                (path.clone(), text)
            })
            .collect()
    }

    /// The first widening the relay's reach shows after any write, the first
    /// included, when the writes are made in this order.
    fn widening_in_order(
        before: &BTreeMap<String, Vec<u8>>,
        writes: &[(&str, &str)],
    ) -> Option<String> {
        let before = texts(before);
        let mut after = before.clone();
        for (path, text) in writes {
            after.insert((*path).to_owned(), (*text).to_owned());
        }
        let mut state = before.clone();
        writes.iter().find_map(|(path, text)| {
            state.insert((*path).to_owned(), (*text).to_owned());
            relay_reach::widening(&before, &state, &after, &[])
        })
    }

    fn plan(before: &BTreeMap<String, Vec<u8>>, writes: &[(&str, &str)]) -> RuleFileOrder {
        let steps: Vec<_> = writes
            .iter()
            .map(|(path, text)| RuleFileStep::Write(path, text.as_bytes()))
            .collect();
        safe_rule_file_order(before, &steps, &[])
    }

    fn safe_writes(order: RuleFileOrder) -> Vec<usize> {
        match order {
            RuleFileOrder::Safe { writes, deletes } => {
                assert!(deletes.is_empty());
                writes
            }
            other => panic!("no safe order: {other:?}"),
        }
    }

    fn in_order<'a>(writes: &[(&'a str, &'a str)], order: &[usize]) -> Vec<(&'a str, &'a str)> {
        order.iter().map(|&index| writes[index]).collect()
    }

    #[test]
    fn a_merge_writes_an_inner_rule_before_an_outer_widening() {
        // The outer folder widens while a rule is created inside it: outer
        // first would give team/private Edit, where it had View before and
        // after.
        let before = rule_files(&[("team/access.yaml", "members: view\n")]);
        let writes = [
            ("team/access.yaml", "members: edit\n"),
            ("team/private/access.yaml", "members: view\n"),
        ];
        assert!(widening_in_order(&before, &writes).is_some());
        let order = safe_writes(plan(&before, &writes));
        assert_eq!(order, [1, 0]);
        assert_eq!(widening_in_order(&before, &in_order(&writes, &order)), None);
    }

    #[test]
    fn a_merge_hides_an_inner_folder_before_showing_the_outer_one() {
        // The outer folder goes from hidden to shown while the inner one turns
        // to hidden: outer first would show team/private at Edit.
        let before = rule_files(&[
            ("team/access.yaml", "people:\n"),
            ("team/private/access.yaml", "members: edit\n"),
        ]);
        let writes = [
            ("team/access.yaml", "members: view\n"),
            ("team/private/access.yaml", "people:\n"),
        ];
        assert!(widening_in_order(&before, &writes).is_some());
        let order = safe_writes(plan(&before, &writes));
        assert_eq!(order, [1, 0]);
        assert_eq!(widening_in_order(&before, &in_order(&writes, &order)), None);
    }

    #[test]
    fn a_merge_hides_an_outer_folder_before_widening_an_inner_one() {
        // The mirror: the inner rule widens while the outer one turns to
        // hidden. The outer write goes first, as it already did.
        let before = rule_files(&[
            ("team/access.yaml", "members: view\n"),
            ("team/private/access.yaml", "members: view\n"),
        ]);
        let writes = [
            ("team/access.yaml", "people:\n"),
            ("team/private/access.yaml", "members: edit\n"),
        ];
        assert!(widening_in_order(&before, &[writes[1], writes[0]]).is_some());
        assert_eq!(safe_writes(plan(&before, &writes)), [0, 1]);
        assert_eq!(widening_in_order(&before, &writes), None);
    }

    #[test]
    fn a_merge_with_no_safe_order_of_rule_writes_is_refused() {
        // Team first gives the person Edit in team/sub, where they end with
        // View; team/sub first gives members Edit there, where they end hidden.
        let before = rule_files(&[]);
        let writes = [
            ("team/access.yaml", "people:\n  p@example.com: edit\n"),
            (
                "team/sub/access.yaml",
                "members: edit\npeople:\n  p@example.com: view\n",
            ),
        ];
        assert!(widening_in_order(&before, &writes).is_some());
        assert!(widening_in_order(&before, &[writes[1], writes[0]]).is_some());
        assert_eq!(
            plan(&before, &writes),
            RuleFileOrder::Widens {
                writes: vec![0, 1],
                deletes: Vec::new()
            }
        );
    }

    #[test]
    fn a_merge_deletes_rules_after_its_writes_within_the_same_bounds() {
        // The outer rule narrows to View and the inner one that hid
        // team/private goes: the write first, then the delete, which leaves
        // team/private at View.
        let before = rule_files(&[
            ("team/access.yaml", "members: edit\n"),
            ("team/private/access.yaml", "people:\n"),
        ]);
        let write = [RuleFileStep::Write("team/access.yaml", b"members: view\n")];
        let delete = [RuleFileStep::Delete("team/private/access.yaml")];
        assert_eq!(
            safe_rule_file_order(&before, &write, &delete),
            RuleFileOrder::Safe {
                writes: vec![0],
                deletes: vec![0]
            }
        );
    }

    /// Sol's case from review: the two-rule reorder with fifteen unrelated
    /// new rules beside it. Unrelated rules are ordered apart, so they don't
    /// use up the search, and the reorder is still found.
    #[test]
    fn unrelated_rules_leave_a_merge_its_safe_order() {
        let before = rule_files(&[("team/access.yaml", "members: view\n")]);
        let others: Vec<String> = (0..15)
            .map(|index| format!("z{index}/access.yaml"))
            .collect();
        let mut writes = vec![
            ("team/access.yaml", "members: edit\n"),
            ("team/private/access.yaml", "members: view\n"),
        ];
        writes.extend(others.iter().map(|path| (path.as_str(), "members: view\n")));
        assert_eq!(writes.len(), 17);
        assert!(widening_in_order(&before, &writes).is_some());
        let order = safe_writes(plan(&before, &writes));
        let expected: Vec<usize> = [1, 0].into_iter().chain(2..17).collect();
        assert_eq!(order, expected);
        assert_eq!(widening_in_order(&before, &in_order(&writes, &order)), None);
    }

    /// Past the search's limit the planner says so, rather than that no
    /// order exists.
    #[test]
    fn a_search_that_reaches_its_limit_says_so() {
        let before = rule_files(&[]);
        let others: Vec<String> = (0..63)
            .map(|index| format!("team/a{index}/access.yaml"))
            .collect();
        let mut writes = vec![
            ("team/access.yaml", "people:\n  p@example.com: edit\n"),
            (
                "team/sub/access.yaml",
                "members: edit\npeople:\n  p@example.com: view\n",
            ),
        ];
        writes.extend(others.iter().map(|path| (path.as_str(), "members: view\n")));
        assert!(matches!(
            plan(&before, &writes),
            RuleFileOrder::TooMany { writes, .. } if writes.len() == 65
        ));
    }

    #[test]
    fn a_checked_order_is_judged_after_every_step() {
        let before = rule_files(&[("team/access.yaml", "members: view\n")]);
        let outer = RuleFileStep::Write("team/access.yaml", b"members: edit\n");
        let inner = RuleFileStep::Write("team/private/access.yaml", b"members: view\n");
        assert!(!rule_file_order_is_safe(&before, &[outer, inner]));
        assert!(rule_file_order_is_safe(&before, &[inner, outer]));
        assert!(rule_file_order_is_safe(&before, &[]));
    }
}
