//! A folder's access rule, read from the `access.yaml` inside it.
//!
//! The twin of `packages/security-contract/src/accessRules.ts`. Both read
//! `accessRules.vectors.json` in their tests, so a rule means the same thing
//! to the engine that publishes it and the relay that enforces it. The engine
//! needs the parser and the narrowing check to order rule changes before the
//! files they cover; the relay owns evaluation.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

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

/// `folder` and each folder above it, the root first.
fn chain(folder: &str) -> impl Iterator<Item = &str> {
    std::iter::once("").chain(
        folder
            .match_indices('/')
            .map(|(slash, _)| &folder[..slash])
            .chain((!folder.is_empty()).then_some(folder)),
    )
}

/// How many folders deep `folder` is: 0 for the root.
fn depth(folder: &str) -> usize {
    if folder.is_empty() {
        0
    } else {
        folder.matches('/').count() + 1
    }
}

/// What a member reaches in `folder`, as the relay's `folderLevel` reads it
/// when no two folders' names fold together: rules apply from the root down,
/// each replaces the level above, and one that leaves the member out hides
/// everything below. `email` is a person a rule names, or `None` for a member
/// none names. The engine refuses a merge order that relies on this where
/// folder names fold together, unless the merge only respells them.
fn reach_in(
    rules: &BTreeMap<&str, Option<&AccessRule>>,
    folder: &str,
    email: Option<&str>,
) -> Reach {
    let mut reach = Reach::Workspace;
    for ancestor in chain(folder) {
        let Some(&rule) = rules.get(ancestor) else {
            continue;
        };
        match rule_level(rule, email) {
            Some(level) => reach = Reach::Level(level),
            None => return Reach::Hidden,
        }
    }
    reach
}

/// The level one rule gives a person, or `None` when it leaves them out. A
/// rule that can't be read leaves everyone out.
fn rule_level(rule: Option<&AccessRule>, email: Option<&str>) -> Option<Level> {
    rule.and_then(|rule| match email {
        Some(email) => level_for_email(rule, email),
        None => rule.members,
    })
}

/// Whether `folder`'s own rule leaves this person out.
fn leaves_out(
    rules: &BTreeMap<&str, Option<&AccessRule>>,
    folder: &str,
    email: Option<&str>,
) -> bool {
    rules
        .get(folder)
        .is_some_and(|&rule| rule_level(rule, email).is_none())
}

/// The people named in `folders`, from each folder's people in `named`,
/// taking the work of reading each name before it keeps any.
fn named_in<'a, 'f>(
    named: &BTreeMap<&'a str, BTreeSet<&'a str>>,
    folders: impl IntoIterator<Item = &'f str>,
    work: &mut RuleOrderWork,
) -> Option<BTreeSet<&'a str>> {
    let found: Vec<&BTreeSet<&'a str>> = folders
        .into_iter()
        .filter_map(|folder| named.get(folder))
        .collect();
    work.take(found.iter().map(|people| people.len()).sum())?;
    Some(found.into_iter().flatten().copied().collect())
}

/// A rule file a change of many paths writes, with its bytes, or deletes.
#[derive(Clone, Copy, Debug)]
pub enum RuleFileStep<'a> {
    Write(&'a str, &'a [u8]),
    Delete(&'a str),
}

fn parsed(bytes: &[u8]) -> Option<AccessRule> {
    if bytes.len() > ACCESS_RULE_MAX_BYTES {
        return None;
    }
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

/// How much work ordering a merge's rule changes may take, over everything
/// it reads, prepares, keeps and judges, before it stops. A unit is about one
/// reach judgement, one entry kept, one path read or [`RULE_BYTES_PER_WORK`]
/// bytes of a rule. It runs on the engine's write thread.
const RULE_ORDER_WORK: usize = 2_000_000;

/// How many bytes of a rule file one unit of [`RuleOrderWork`] reads.
pub const RULE_BYTES_PER_WORK: usize = 64;

/// The work left for ordering one merge's rule changes, or for checking one
/// order, from reading the store to the last judgement. Each part takes its
/// share before it allocates or walks, so the whole of it stops at the limit.
pub struct RuleOrderWork(usize);

impl Default for RuleOrderWork {
    fn default() -> Self {
        Self(RULE_ORDER_WORK)
    }
}

impl RuleOrderWork {
    /// `None`, leaving nothing, when `cost` is more than is left.
    pub fn take(&mut self, cost: usize) -> Option<()> {
        let left = self.0.checked_sub(cost);
        self.0 = left.unwrap_or(0);
        left.map(drop)
    }

    /// The work of reading a rule file of `bytes` bytes.
    pub fn take_bytes(&mut self, bytes: usize) -> Option<()> {
        self.take(1 + bytes / RULE_BYTES_PER_WORK)
    }

    /// `units` of work, for a test that runs it out.
    #[cfg(any(test, feature = "test-support"))]
    pub fn limited(units: usize) -> Self {
        Self(units)
    }
}

/// The rules before a change of many rule files, and what each member may
/// reach while it is made: no more than both the rules before and the rules
/// after give them, at the root and at every folder that holds a rule before
/// or after. Only points at or under a step's folder can move, so only those
/// are kept.
///
/// A folder no rule names, on a path a version spells, reaches what its
/// nearest point above it does. A path no version spells can also pass
/// through a step folder's key group without passing through that folder,
/// as `team` passes `Team`'s. The relay then applies that rule's hide but
/// not its level. See [`Anchor`].
struct Change<'a> {
    start: RuleFiles<'a>,
    /// Each folder's rule before and after.
    before: BTreeMap<&'a str, Option<&'a AccessRule>>,
    after: BTreeMap<&'a str, Option<&'a AccessRule>>,
    /// Each person at each point, with their reach before and after, point
    /// by point.
    bounds: Vec<(Option<&'a str>, Reach, Reach)>,
    /// Each point, with the range of its people in `bounds`.
    points: Vec<(&'a str, Range<usize>)>,
    /// For each step, the points at or under its folder: the only ones it
    /// can move.
    affected: Vec<Vec<usize>>,
    anchors: Vec<Anchor<'a>>,
    /// For each step, the anchors it can move.
    anchored: Vec<Vec<usize>>,
    /// For each step, the work judging a state it made takes: each bound it
    /// can move, by how deep that bound's point is, and each anchor.
    cost: Vec<usize>,
}

/// A point, and the step folders whose key groups a folder under it that
/// no version spells can pass through, such as `team/x` under the root
/// beside a step in `Team`. Such a folder is hidden while the point is, or
/// while one of those step folders leaves the person out. Otherwise it
/// reaches what the point does.
///
/// It reaches more than both before and after only in two cases. In the
/// first, it passes through a step folder that shows the person now and
/// hides them after, while the point reaches more now than before, or the
/// mirror of that. In the second, it passes through two step folders on one
/// key chain, both showing the person now: one hid them before and the
/// other hides them after. A name can fold to several segments, as `a／x`
/// does, so a folder can pass any of those key groups and skip the rest.
/// Only a step folder that leaves someone out before or after but not both,
/// or that holds two steps, can take part.
///
/// The first case needs one twin and the second two on one key chain, so a
/// point keeps an anchor for each group of its twins joined by key chains.
/// Its people and its cost then grow with that group, not with every twin.
struct Anchor<'a> {
    folder: &'a str,
    /// Each such step folder, with its key.
    twins: Vec<(&'a str, String)>,
    /// Each person, with their reach at the point before and after.
    people: Vec<(Option<&'a str>, Reach, Reach)>,
}

impl<'a> Change<'a> {
    /// The bounds for making `active`, indexes into `steps`, from `start`.
    /// `None` when preparing them would take more work than is left.
    fn new(
        start: RuleFiles<'a>,
        steps: &[Step<'a>],
        active: &[usize],
        work: &mut RuleOrderWork,
    ) -> Option<Self> {
        work.take(start.len() + active.len())?;
        let mut end = start.clone();
        let mut movers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for &step in active {
            steps[step].apply(&mut end);
            movers.entry(steps[step].folder).or_default().push(step);
        }
        let (before, after) = (folder_rules(&start), folder_rules(&end));
        // Each folder, with the people its rule files name before and after.
        // Two files in one folder are one rule nobody can read, but partway
        // either can stand alone, so the people each names need bounds too.
        work.take(
            start
                .values()
                .chain(end.values())
                .map(|rule| rule.map_or(1, |rule| 1 + rule.people.len()))
                .sum(),
        )?;
        let mut named: BTreeMap<&'a str, BTreeSet<&'a str>> = BTreeMap::new();
        for (&path, &rule) in start.iter().chain(&end) {
            named.entry(access_rule_folder(path)).or_default().extend(
                rule.into_iter()
                    .flat_map(|rule| rule.people.keys().map(String::as_str)),
            );
        }
        let candidates: BTreeSet<&'a str> = std::iter::once("")
            .chain(
                start
                    .keys()
                    .chain(end.keys())
                    .map(|&path| access_rule_folder(path)),
            )
            .collect();
        let mut change = Self {
            start,
            before: BTreeMap::new(),
            after: BTreeMap::new(),
            bounds: Vec::new(),
            points: Vec::new(),
            affected: vec![Vec::new(); steps.len()],
            anchors: Vec::new(),
            anchored: vec![Vec::new(); steps.len()],
            cost: vec![0; steps.len()],
        };
        for &point in &candidates {
            work.take(depth(point) + 1)?;
            let movers_of = || chain(point).filter_map(|folder| movers.get(folder));
            // Charged before it is kept, as in `anchor`.
            work.take(movers_of().map(Vec::len).sum())?;
            let moved_by: Vec<usize> = movers_of().flatten().copied().collect();
            if moved_by.is_empty() {
                continue;
            }
            // A person no rule at or above this point names reaches what a
            // member no rule names does, in every state, so only those named
            // here need bounds of their own.
            let emails = named_in(&named, chain(point), work)?;
            // Each bound walks the point's folders from the root.
            let walk = depth(point) + 1;
            work.take(2 * (emails.len() + 1) * walk)?;
            let first = change.bounds.len();
            for email in std::iter::once(None).chain(emails.into_iter().map(Some)) {
                change.bounds.push((
                    email,
                    reach_in(&before, point, email),
                    reach_in(&after, point, email),
                ));
            }
            let people = change.bounds.len() - first;
            let index = change.points.len();
            change.points.push((point, first..change.bounds.len()));
            for step in moved_by {
                change.affected[step].push(index);
                change.cost[step] += people * walk;
            }
        }
        (change.before, change.after) = (before, after);
        change.anchor(steps, &candidates, &movers, &named, work)?;
        Some(change)
    }

    /// Keeps an [`Anchor`] for each point with a step folder in its key
    /// groups that can show someone a folder no version spells.
    fn anchor(
        &mut self,
        steps: &[Step<'a>],
        points: &BTreeSet<&'a str>,
        movers: &BTreeMap<&'a str, Vec<usize>>,
        named: &BTreeMap<&'a str, BTreeSet<&'a str>>,
        work: &mut RuleOrderWork,
    ) -> Option<()> {
        let (before, after) = (&self.before, &self.after);
        let mut twins = Vec::new();
        for (&folder, moved) in movers {
            let emails = named_in(named, [folder], work)?;
            work.take(depth(folder) + 1)?;
            let changes = std::iter::once(None)
                .chain(emails.into_iter().map(Some))
                .any(|email| leaves_out(before, folder, email) != leaves_out(after, folder, email));
            if moved.len() > 1 || changes {
                twins.push((folder, path_collision_key(folder)));
            }
        }
        if twins.is_empty() {
            return Some(());
        }
        // The twins by key chains, through one step of each.
        let firsts: Vec<usize> = twins.iter().map(|(folder, _)| movers[folder][0]).collect();
        let mut group_of = BTreeMap::new();
        for (group, list) in independent_groups(steps, &firsts, work)?
            .into_iter()
            .enumerate()
        {
            group_of.extend(list.into_iter().map(|step| (step, group)));
        }
        // Each point by its key, then each twin under each point's key.
        let mut by_key: BTreeMap<String, Vec<&'a str>> = BTreeMap::new();
        for &point in points {
            work.take(depth(point) + 1)?;
            by_key
                .entry(path_collision_key(point))
                .or_default()
                .push(point);
        }
        // Each point's twins, by their group.
        let mut under: BTreeMap<(&'a str, usize), Vec<usize>> = BTreeMap::new();
        for (index, (_, key)) in twins.iter().enumerate() {
            work.take(depth(key) + 1)?;
            let group = group_of[&firsts[index]];
            for above in chain(key).filter(|above| above != key) {
                for &point in by_key.get(above).into_iter().flatten() {
                    // Charged before it is kept: many spellings of one key
                    // above many twins would otherwise grow this unbounded.
                    work.take(1)?;
                    under.entry((point, group)).or_default().push(index);
                }
            }
        }
        for ((folder, _), found) in under {
            // A person no rule here names reaches what a member none names
            // does. Each found twin was charged once when it was kept.
            work.take(2 * (depth(folder) + 1) + found.len())?;
            let emails = named_in(
                named,
                chain(folder).chain(found.iter().map(|&twin| twins[twin].0)),
                work,
            )?;
            let walk = depth(folder) + 1;
            let judging: usize = walk
                + found
                    .iter()
                    .map(|&twin| depth(&twins[twin].1) + 4)
                    .sum::<usize>();
            let people = emails.len() + 1;
            work.take(2 * people * walk + people * judging)?;
            let index = self.anchors.len();
            self.anchors.push(Anchor {
                folder,
                twins: found.iter().map(|&twin| twins[twin].clone()).collect(),
                people: std::iter::once(None)
                    .chain(emails.into_iter().map(Some))
                    .map(|email| {
                        (
                            email,
                            reach_in(before, folder, email),
                            reach_in(after, folder, email),
                        )
                    })
                    .collect(),
            });
            let movers_of = || {
                chain(folder)
                    .chain(found.iter().map(|&twin| twins[twin].0))
                    .filter_map(|folder| movers.get(folder))
            };
            // Charged before it is kept: one folder can hold many rule files,
            // each its own step, under many spellings of one key above it.
            work.take(movers_of().map(Vec::len).sum())?;
            let moved_by: BTreeSet<usize> = movers_of().flatten().copied().collect();
            for step in moved_by {
                self.anchored[step].push(index);
                self.cost[step] += people * judging;
            }
        }
        Some(())
    }

    /// Whether `files`, which `step` made from a state within bounds, is
    /// still within them.
    fn safe_after(&self, files: &RuleFiles<'a>, step: usize) -> bool {
        let rules = folder_rules(files);
        self.affected[step].iter().all(|&point| {
            let (folder, people) = &self.points[point];
            self.bounds[people.clone()]
                .iter()
                .all(|&(email, before, after)| {
                    let reach = reach_in(&rules, folder, email);
                    reach.within(before) || reach.within(after)
                })
        }) && self.anchored[step]
            .iter()
            .all(|&anchor| self.anchor_safe(&rules, &self.anchors[anchor]))
    }

    /// Whether no folder under `anchor` that passes through its twins' key
    /// groups reaches more than both before and after give.
    fn anchor_safe(
        &self,
        rules: &BTreeMap<&'a str, Option<&'a AccessRule>>,
        anchor: &Anchor<'a>,
    ) -> bool {
        anchor.people.iter().all(|&(email, before, after)| {
            let reach = reach_in(rules, anchor.folder, email);
            if reach == Reach::Hidden {
                return true;
            }
            // The twins that show this person now, by which of them hid
            // them before and which hide them after.
            let (mut hid, mut hides) = (BTreeSet::new(), BTreeSet::new());
            for (folder, key) in &anchor.twins {
                if leaves_out(rules, folder, email) {
                    continue;
                }
                if leaves_out(&self.before, folder, email) {
                    hid.insert(key.as_str());
                }
                if leaves_out(&self.after, folder, email) {
                    hides.insert(key.as_str());
                }
            }
            let above = |from: &BTreeSet<&str>, to: &BTreeSet<&str>| {
                from.iter()
                    .any(|key| chain(key).any(|above| to.contains(above)))
            };
            !((!reach.within(before) && !hides.is_empty())
                || (!reach.within(after) && !hid.is_empty())
                || above(&hid, &hides)
                || above(&hides, &hid))
        })
    }
}

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
    /// Ordering these steps would take more than the work limit. An order
    /// may still exist.
    TooMany {
        writes: Vec<usize>,
        deletes: Vec<usize>,
    },
    /// These steps are in folders whose names fold together with another
    /// folder's, and they do more than respell such folders apart from every
    /// other step. The order doesn't judge how the relay reads such folders.
    Folded {
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
    work: &'c mut RuleOrderWork,
}

impl<'a> Search<'_, 'a> {
    /// Takes the work of judging one state that `step` made from `files`.
    fn charge(&mut self, files: &RuleFiles<'a>, step: usize) -> bool {
        self.work
            .take(self.change.cost[step] + files.len() + 1)
            .is_some()
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

/// The steps in `active` in groups that can't affect each other: two steps
/// share a group when one's folder is at or under the other's, however
/// their names fold. A folder's reach depends only on the rules in the key
/// groups at and above it, so every folder is moved by one group at most.
/// Each group lists its steps in the order given.
fn independent_groups(
    steps: &[Step<'_>],
    active: &[usize],
    work: &mut RuleOrderWork,
) -> Option<Vec<Vec<usize>>> {
    fn root(parent: &mut [usize], mut index: usize) -> usize {
        while parent[index] != index {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        index
    }
    work.take(steps.len() + active.len())?;
    let mut parent: Vec<usize> = (0..steps.len()).collect();
    let mut keys = BTreeMap::new();
    let mut first: BTreeMap<String, usize> = BTreeMap::new();
    for &step in active {
        work.take(depth(steps[step].folder) + 1)?;
        let key = path_collision_key(steps[step].folder);
        first.entry(key.clone()).or_insert(step);
        keys.insert(step, key);
    }
    for (&step, key) in &keys {
        work.take(depth(key) + 1)?;
        for folder in chain(key) {
            if let Some(&other) = first.get(folder) {
                let (a, b) = (root(&mut parent, step), root(&mut parent, other));
                parent[a.max(b)] = a.min(b);
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for &step in active {
        let group = root(&mut parent, step);
        groups.entry(group).or_default().push(step);
    }
    Some(groups.into_values().collect())
}

/// Where a step goes when it only respells a folder: writes first, deepest
/// first, then deletes, outermost first.
fn respelling_rank(step: &Step<'_>) -> (bool, usize) {
    let deep = depth(step.folder);
    match step.rule {
        Some(_) => (false, usize::MAX - deep),
        None => (true, deep),
    }
}

/// Whether the steps in `seq`, made in [`respelling_rank`] order from
/// `start`, only respell folders whose names fold together. Every spelling
/// of each such folder holds one rule file, all of them the same rule,
/// before, after and in every state between, and some spelling holds it in
/// every state. `start` holds every rule file in a folder whose name folds
/// together with a step's.
///
/// The relay then hides each such folder by that same rule in every state.
/// Where it doesn't, a path reaches what the rule in its deepest ruled
/// folder gives. Writing deepest first, that is the rule there before the
/// merge until the path's deepest folder after the merge is written, and
/// that one's rule after. Deleting outermost first is the same, reversed.
fn only_respells(start: &RuleFiles<'_>, steps: &[Step<'_>], seq: &[usize]) -> bool {
    let mut groups: BTreeMap<String, (RuleFiles<'_>, Vec<usize>)> = BTreeMap::new();
    for &step in seq {
        groups
            .entry(path_collision_key(steps[step].folder))
            .or_default()
            .1
            .push(step);
    }
    for (&path, &rule) in start {
        if let Some((files, _)) = groups.get_mut(&path_collision_key(access_rule_folder(path))) {
            files.insert(path, rule);
        }
    }
    groups.into_values().all(|(before, group)| {
        let mut after = before.clone();
        let mut paths: BTreeSet<&str> = before.keys().copied().collect();
        let mut rules: Vec<Option<&AccessRule>> = before.values().copied().collect();
        for &step in &group {
            steps[step].apply(&mut after);
            paths.insert(steps[step].path);
            rules.extend(steps[step].rule);
        }
        let folders: BTreeSet<&str> = paths.iter().map(|path| access_rule_folder(path)).collect();
        !before.is_empty()
            && !after.is_empty()
            && folders.len() == paths.len()
            && rules.windows(2).all(|pair| pair[0] == pair[1])
    })
}

/// Whether no step in `a` is at, under or above a step in `b`, however
/// their folders' names fold.
fn apart(steps: &[Step<'_>], a: &[usize], b: &[usize]) -> bool {
    let keys = |list: &[usize]| -> BTreeSet<String> {
        list.iter()
            .map(|&step| path_collision_key(steps[step].folder))
            .collect()
    };
    let (a, b) = (keys(a), keys(b));
    let reaches = |from: &BTreeSet<String>, to: &BTreeSet<String>| {
        from.iter()
            .any(|key| chain(key).any(|folder| to.contains(folder)))
    };
    !reaches(&a, &b) && !reaches(&b, &a)
}

/// The steps in folders whose names fold together, put in respelling order,
/// and the rest, in the order given; or `None` when the first don't only
/// respell their folders apart from the rest.
fn respelled_apart(
    start: &RuleFiles<'_>,
    steps: &[Step<'_>],
    folded: &BTreeSet<String>,
) -> Option<(Vec<usize>, Vec<usize>)> {
    let (mut respelled, rest): (Vec<usize>, Vec<usize>) =
        (0..steps.len()).partition(|&step| folded.contains(steps[step].path));
    respelled.sort_by_key(|&step| respelling_rank(&steps[step]));
    (respelled.is_empty()
        || (apart(steps, &respelled, &rest) && only_respells(start, steps, &respelled)))
    .then_some((respelled, rest))
}

/// The work of reading each step's folder names and the rules before, and of
/// telling whether the steps only respell their folders: each folder's key,
/// once to group it and once to keep it apart, and each rule compared with
/// the next.
fn reading_work(start: &RuleFiles<'_>, steps: &[Step<'_>]) -> usize {
    let rule = |rule: Option<&AccessRule>| 1 + rule.map_or(0, |rule| rule.people.len());
    start
        .iter()
        .map(|(path, &kept)| depth(access_rule_folder(path)) + 1 + rule(kept))
        .sum::<usize>()
        + steps
            .iter()
            .map(|step| 2 * (depth(step.folder) + 1) + step.rule.map_or(1, rule))
            .sum::<usize>()
}

/// Reads each rule once, taking the work of parsing it and of keeping its
/// people before keeping it, and hands `run` the rules before the change and
/// each step with its rule. `None` when the work runs out first.
fn with_steps<T>(
    before: &BTreeMap<String, Vec<u8>>,
    steps: &[RuleFileStep<'_>],
    work: &mut RuleOrderWork,
    run: impl for<'a> FnOnce(RuleFiles<'a>, Vec<Step<'a>>, &mut RuleOrderWork) -> T,
) -> Option<T> {
    let mut read = |bytes: &[u8]| -> Option<Option<AccessRule>> {
        work.take_bytes(bytes.len().min(ACCESS_RULE_MAX_BYTES))?;
        let rule = parsed(bytes);
        work.take(rule.as_ref().map_or(0, |rule| rule.people.len()))?;
        Some(rule)
    };
    let mut kept = Vec::with_capacity(before.len());
    for (path, bytes) in before {
        kept.push((path.as_str(), read(bytes)?));
    }
    let mut written = Vec::with_capacity(steps.len());
    for step in steps {
        written.push(match step {
            RuleFileStep::Write(_, bytes) => read(bytes)?,
            RuleFileStep::Delete(_) => None,
        });
    }
    let start = kept
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
    Some(run(start, steps, work))
}

/// An order for writing, then deleting, many rule files one at a time, in
/// which no step gives any member more anywhere than both the rules before
/// and the rules after give them. Each phase tries the order given first.
///
/// `before` is every rule file before the change, and every rule file in a
/// folder whose name folds together with a step's. Files merge between the
/// two phases, so the state after the writes must stay within bounds too.
/// Steps in folders apart from each other are ordered apart, so unrelated
/// rules neither share nor use up one search. `folded` names the steps in
/// folders whose names fold together with another folder's: they may only
/// respell those folders, apart from every other step. Reading, preparing
/// and searching all take from `work`, which reading the store may already
/// have used.
pub fn safe_rule_file_order(
    before: &BTreeMap<String, Vec<u8>>,
    writes: &[RuleFileStep<'_>],
    deletes: &[RuleFileStep<'_>],
    folded: &BTreeSet<String>,
    work: &mut RuleOrderWork,
) -> RuleFileOrder {
    // One step goes straight from before to after.
    if writes.len() + deletes.len() < 2 {
        return RuleFileOrder::Safe {
            writes: (0..writes.len()).collect(),
            deletes: (0..deletes.len()).collect(),
        };
    }
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
    let too_many = |group: &[usize]| {
        let (writes, deletes) = split(group);
        RuleFileOrder::TooMany { writes, deletes }
    };
    let everything: Vec<usize> = (0..all.len()).collect();
    let found = with_steps(before, &all, work, |start, steps, work| {
        if work.take(reading_work(&start, &steps)).is_none() {
            return too_many(&everything);
        }
        let Some((respelled, rest)) = respelled_apart(&start, &steps, folded) else {
            let folded: Vec<usize> = everything
                .iter()
                .copied()
                .filter(|&step| folded.contains(steps[step].path))
                .collect();
            let (writes, deletes) = split(&folded);
            return RuleFileOrder::Folded { writes, deletes };
        };
        let Some(groups) = independent_groups(&steps, &rest, work) else {
            return too_many(&rest);
        };
        let Some(change) = Change::new(start, &steps, &rest, work) else {
            return too_many(&rest);
        };
        let mut search = Search {
            change: &change,
            steps: &steps,
            work,
        };
        // Respelled folders are apart from every other step, so their writes
        // and deletes go around the others' unchanged.
        let (mut write_order, respelled_deletes) = split(&respelled);
        let mut delete_order = Vec::new();
        for group in groups {
            let (group_writes, group_deletes): (Vec<usize>, Vec<usize>) =
                group.iter().partition(|&&step| step < writes.len());
            // A group moves only its own folders, so it starts from the
            // rules before the change, whatever the other groups did.
            if search.work.take(change.start.len()).is_none() {
                return too_many(&group);
            }
            let mut files = change.start.clone();
            let written = match search.phase(&files, &group_writes) {
                Found::Order(order) => order,
                Found::None => {
                    let (writes, deletes) = split(&group);
                    return RuleFileOrder::Widens { writes, deletes };
                }
                Found::OutOfWork => return too_many(&group),
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
                Found::OutOfWork => return too_many(&group),
            };
            write_order.extend(written);
            delete_order.extend(deleted.into_iter().map(|step| step - writes.len()));
        }
        delete_order.extend(respelled_deletes);
        RuleFileOrder::Safe {
            writes: write_order,
            deletes: delete_order,
        }
    });
    found.unwrap_or_else(|| too_many(&everything))
}

/// Whether making `steps` one at a time, in this order, from `before`, keeps
/// everyone within what the rules before and after give them after each one.
/// `before`, `folded` and `work` are as [`safe_rule_file_order`] takes them.
/// It is `false` too when the work runs out first.
pub fn rule_file_order_is_safe(
    before: &BTreeMap<String, Vec<u8>>,
    steps: &[RuleFileStep<'_>],
    folded: &BTreeSet<String>,
    work: &mut RuleOrderWork,
) -> bool {
    if steps.len() < 2 {
        return true;
    }
    with_steps(before, steps, work, |start, steps, work| {
        if work.take(reading_work(&start, &steps)).is_none() {
            return false;
        }
        let Some((respelled, rest)) = respelled_apart(&start, &steps, folded) else {
            return false;
        };
        // The order given must already be the respelling order.
        let given: Vec<usize> = (0..steps.len())
            .filter(|&step| folded.contains(steps[step].path))
            .collect();
        if given != respelled {
            return false;
        }
        let Some(change) = Change::new(start, &steps, &rest, work) else {
            return false;
        };
        if work.take(change.start.len()).is_none() {
            return false;
        }
        let mut files = change.start.clone();
        rest.iter().all(|&step| {
            work.take(change.cost[step] + files.len() + 1).is_some() && {
                steps[step].apply(&mut files);
                change.safe_after(&files, step)
            }
        })
    })
    .unwrap_or(false)
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
        #[serde(rename = "ruleFiles")]
        rule_files: Vec<RuleFileCase>,
    }

    #[derive(serde::Deserialize)]
    struct RuleFileCase {
        name: String,
        files: BTreeMap<String, String>,
        folder: String,
        email: Option<String>,
        level: Option<String>,
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
        folds_together(case.rules.keys().map(String::as_str), &case.folder)
    }

    fn folds_together<'a>(ruled: impl Iterator<Item = &'a str>, folder: &'a str) -> bool {
        let names: BTreeSet<&str> = ruled.chain(chain(folder)).collect();
        let keys: BTreeSet<String> = names.iter().map(|name| path_collision_key(name)).collect();
        keys.len() < names.len()
    }

    #[test]
    fn reaches_folders_in_the_shared_vectors_as_the_relay_does() {
        for case in vectors().reach {
            let rules = reach_rules(&case);
            for member in [Level::View, Level::Comment, Level::Edit] {
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

    /// Cases that start from rule files: the relay reads two in one folder
    /// as one unreadable rule, and a file named `access.yaml` in another case
    /// as its folder's rule. The planner reads them the same way.
    #[test]
    fn reaches_folders_from_the_shared_rule_files_as_the_relay_does() {
        for case in vectors().rule_files {
            assert!(
                case.files.keys().all(|path| is_access_rule_path(path)),
                "{}",
                case.name
            );
            let rules = relay_reach::rules_by_folder(&case.files);
            for member in [Level::View, Level::Comment, Level::Edit] {
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
            let ruled = case.files.keys().map(|path| access_rule_folder(path));
            if folds_together(ruled, &case.folder) {
                continue;
            }
            let parsed: Vec<(&str, Option<AccessRule>)> = case
                .files
                .iter()
                .map(|(path, text)| (path.as_str(), parse_access_rule(text)))
                .collect();
            let files: RuleFiles<'_> = parsed
                .iter()
                .map(|(path, rule)| (*path, rule.as_ref()))
                .collect();
            let expected = match case.level.as_deref() {
                Some("member") => Reach::Workspace,
                Some(word) => Reach::Level(level(word)),
                None => Reach::Hidden,
            };
            assert_eq!(
                reach_in(&folder_rules(&files), &case.folder, case.email.as_deref()),
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
        safe_rule_file_order(
            before,
            &steps,
            &[],
            &BTreeSet::new(),
            &mut RuleOrderWork::default(),
        )
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
            safe_rule_file_order(
                &before,
                &write,
                &delete,
                &BTreeSet::new(),
                &mut RuleOrderWork::default()
            ),
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
        assert!(!rule_file_order_is_safe(
            &before,
            &[outer, inner],
            &BTreeSet::new(),
            &mut RuleOrderWork::default()
        ));
        assert!(rule_file_order_is_safe(
            &before,
            &[inner, outer],
            &BTreeSet::new(),
            &mut RuleOrderWork::default()
        ));
        assert!(rule_file_order_is_safe(
            &before,
            &[],
            &BTreeSet::new(),
            &mut RuleOrderWork::default()
        ));
    }

    /// Rule files by path for the relay's reach, with every write and
    /// delete of `steps` up to `upto` made.
    fn texts_after(
        before: &BTreeMap<String, Vec<u8>>,
        steps: &[(&str, Option<&str>)],
        upto: usize,
    ) -> BTreeMap<String, String> {
        let mut state = texts(before);
        for (path, text) in &steps[..upto] {
            match text {
                Some(text) => state.insert((*path).to_owned(), (*text).to_owned()),
                None => state.remove(*path),
            };
        }
        state
    }

    /// The first widening the relay's reach shows, at the root, in a ruled
    /// folder or in `folders`, after any step of `steps` made in this order.
    fn widening_in_steps(
        before: &BTreeMap<String, Vec<u8>>,
        steps: &[(&str, Option<&str>)],
        folders: &[&str],
    ) -> Option<String> {
        let start = texts(before);
        let end = texts_after(before, steps, steps.len());
        (1..=steps.len()).find_map(|upto| {
            relay_reach::widening(&start, &texts_after(before, steps, upto), &end, folders)
        })
    }

    fn rule_step<'a>((path, text): &(&'a str, Option<&'a str>)) -> RuleFileStep<'a> {
        match text {
            Some(text) => RuleFileStep::Write(path, text.as_bytes()),
            None => RuleFileStep::Delete(path),
        }
    }

    /// Plans `steps`, every write before every delete, with `folded` the
    /// steps in folders whose names fold together.
    fn plan_steps(
        before: &BTreeMap<String, Vec<u8>>,
        steps: &[(&str, Option<&str>)],
        folded: &[&str],
    ) -> RuleFileOrder {
        let writes: Vec<_> = steps
            .iter()
            .filter(|(_, text)| text.is_some())
            .map(rule_step)
            .collect();
        let deletes: Vec<_> = steps
            .iter()
            .filter(|(_, text)| text.is_none())
            .map(rule_step)
            .collect();
        let folded = folded.iter().map(|path| (*path).to_owned()).collect();
        safe_rule_file_order(
            before,
            &writes,
            &deletes,
            &folded,
            &mut RuleOrderWork::default(),
        )
    }

    /// `steps`, every write before every delete, in the planned order.
    fn planned<'a>(
        steps: &[(&'a str, Option<&'a str>)],
        writes: &[usize],
        deletes: &[usize],
    ) -> Vec<(&'a str, Option<&'a str>)> {
        let (w, d): (Vec<_>, Vec<_>) = steps.iter().copied().partition(|(_, text)| text.is_some());
        writes
            .iter()
            .map(|&index| w[index])
            .chain(deletes.iter().map(|&index| d[index]))
            .collect()
    }

    fn checked(
        before: &BTreeMap<String, Vec<u8>>,
        steps: &[(&str, Option<&str>)],
        folded: &[&str],
    ) -> bool {
        let steps: Vec<_> = steps.iter().map(rule_step).collect();
        let folded = folded.iter().map(|path| (*path).to_owned()).collect();
        rule_file_order_is_safe(before, &steps, &folded, &mut RuleOrderWork::default())
    }

    const SPELLINGS: &[&str] = &[
        "Team", "team", "TEAM", "Team/sub", "team/sub", "Team/SUB", "team/Sub", "TEAM/sub",
    ];

    /// Opus's case from review: a version renames Team to team, which holds
    /// a narrower rule in sub. Main always holds the old spelling, so a
    /// refusal of every folded name refused this merge every time. Writing
    /// team first would give team/sub Edit; writing deepest first and then
    /// deleting outermost first never reaches more on any spelling.
    #[test]
    fn a_respelled_folder_merges_deepest_write_first_and_outermost_delete_first() {
        let before = rule_files(&[
            ("Team/access.yaml", "members: edit\n"),
            ("Team/sub/access.yaml", "members: view\n"),
        ]);
        let steps = [
            ("team/access.yaml", Some("members: edit\n")),
            ("team/sub/access.yaml", Some("members: view\n")),
            ("Team/sub/access.yaml", None),
            ("Team/access.yaml", None),
        ];
        let folded: Vec<&str> = steps.iter().map(|(path, _)| *path).collect();
        assert!(widening_in_steps(&before, &steps, SPELLINGS).is_some());
        assert!(!checked(&before, &steps, &folded));
        let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &folded) else {
            panic!("no order");
        };
        assert_eq!((&writes[..], &deletes[..]), (&[1, 0][..], &[1, 0][..]));
        let order = planned(&steps, &writes, &deletes);
        assert_eq!(widening_in_steps(&before, &order, SPELLINGS), None);
        assert!(checked(&before, &order, &folded));
        // Partway, with only the deletes left, the rest is checked as it is.
        let mut middle = before.clone();
        for (path, text) in &order[..2] {
            middle.insert((*path).to_owned(), text.unwrap().as_bytes().to_vec());
        }
        assert!(checked(&middle, &order[2..], &folded[2..]));
        assert!(!checked(&middle, &[order[3], order[2]], &folded[2..]));
    }

    #[test]
    fn a_unicode_respelling_merges_like_a_case_one() {
        let (composed, decomposed) = ("caf\u{e9}", "cafe\u{301}");
        assert_eq!(path_collision_key(composed), path_collision_key(decomposed));
        let (old, new) = (
            format!("{composed}/access.yaml"),
            format!("{decomposed}/access.yaml"),
        );
        let (old_sub, new_sub) = (
            format!("{composed}/sub/access.yaml"),
            format!("{decomposed}/sub/access.yaml"),
        );
        let before = rule_files(&[
            (&old, "people:\n  p@example.com: edit\n"),
            (&old_sub, VIEW_TEXT),
        ]);
        let steps = [
            (new.as_str(), Some("people:\n  p@example.com: edit\n")),
            (new_sub.as_str(), Some(VIEW_TEXT)),
            (old_sub.as_str(), None),
            (old.as_str(), None),
        ];
        let folded: Vec<&str> = steps.iter().map(|(path, _)| *path).collect();
        let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &folded) else {
            panic!("no order");
        };
        let order = planned(&steps, &writes, &deletes);
        let subs = [format!("{composed}/sub"), format!("{decomposed}/sub")];
        let folders = [composed, decomposed, subs[0].as_str(), subs[1].as_str()];
        assert_eq!(widening_in_steps(&before, &order, &folders), None);
        assert!(checked(&before, &order, &folded));
    }

    const VIEW_TEXT: &str = "members: view\n";

    #[test]
    fn a_respelling_that_also_changes_a_rule_or_a_rule_above_is_refused() {
        let before = rule_files(&[("Team/access.yaml", VIEW_TEXT)]);
        let folded = ["team/access.yaml", "Team/access.yaml"];
        // The rule changes while its folder is respelled.
        let changed = [
            ("team/access.yaml", Some("members: edit\n")),
            ("Team/access.yaml", None),
        ];
        assert!(matches!(
            plan_steps(&before, &changed, &folded),
            RuleFileOrder::Folded { writes, deletes } if writes == [0] && deletes == [0]
        ));
        assert!(!checked(&before, &changed, &folded));
        // The root's rule changes with it, so the two aren't apart.
        let respelled = [
            ("access.yaml", Some("members: edit\n")),
            ("team/access.yaml", Some(VIEW_TEXT)),
            ("Team/access.yaml", None),
        ];
        assert!(matches!(
            plan_steps(&before, &respelled, &folded),
            RuleFileOrder::Folded { .. }
        ));
        // A rule elsewhere is apart, and both are ordered.
        let elsewhere = [
            ("docs/access.yaml", Some("members: edit\n")),
            ("team/access.yaml", Some(VIEW_TEXT)),
            ("Team/access.yaml", None),
        ];
        let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &elsewhere, &folded)
        else {
            panic!("no order");
        };
        let order = planned(&elsewhere, &writes, &deletes);
        assert_eq!(widening_in_steps(&before, &order, SPELLINGS), None);
        // Twins that hold different rules before the merge are refused.
        let twins = rule_files(&[
            ("Team/access.yaml", VIEW_TEXT),
            ("team/access.yaml", "people:\n"),
        ]);
        let swap = [
            ("Team/access.yaml", Some("people:\n")),
            ("team/access.yaml", Some(VIEW_TEXT)),
        ];
        assert!(matches!(
            plan_steps(&twins, &swap, &["Team/access.yaml", "team/access.yaml"]),
            RuleFileOrder::Folded { .. }
        ));
    }

    /// The steps the runtime finds in a folder another folder's name folds
    /// together with, in `states`, when there are two steps or more.
    fn folded_steps<'a>(
        states: &[&BTreeMap<String, String>],
        steps: &[(&'a str, Option<&'a str>)],
    ) -> Vec<&'a str> {
        let spelled: BTreeSet<&str> = states
            .iter()
            .flat_map(|files| files.keys())
            .flat_map(|path| chain(access_rule_folder(path)).skip(1))
            .collect();
        steps
            .iter()
            .filter(|(path, _)| {
                let key = path_collision_key(access_rule_folder(path));
                steps.len() > 1
                    && !access_rule_folder(path).is_empty()
                    && spelled
                        .iter()
                        .filter(|other| path_collision_key(other) == key)
                        .count()
                        > 1
            })
            .map(|(path, _)| *path)
            .collect()
    }

    /// Small pseudo-random respellings, judged with the relay's reach on
    /// every spelling of every folder after every step, from the start and
    /// from each state partway, as the engine checks each rule's merge.
    #[test]
    fn generated_respellings_never_reach_more_on_any_spelling() {
        let texts = [
            "members: view\n",
            "members: edit\n",
            "people:\n",
            "people:\n  p@example.com: edit\n",
            "members: comment\npeople:\n  p@example.com: view\n",
        ];
        let folders = ["", "a", "a/x", "a/y", "b", "b/x"];
        let mut seed: u64 = 0x5eed;
        let mut next = |bound: usize| {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from(seed >> 33).unwrap() % bound
        };
        let variants: Vec<String> = ["", "a", "A", "b", "B"]
            .iter()
            .flat_map(|first| {
                ["", "/x", "/X", "/y"].iter().map(move |second| {
                    if first.is_empty() {
                        String::new()
                    } else {
                        format!("{first}{second}")
                    }
                })
            })
            .collect();
        let points: Vec<&str> = variants.iter().map(String::as_str).collect();
        let (mut ordered, mut respelled_ordered) = (0, 0);
        for _ in 0..1500 {
            let rule_path = |folder: &str| {
                if folder.is_empty() {
                    "access.yaml".to_owned()
                } else {
                    format!("{folder}/access.yaml")
                }
            };
            let mut main: BTreeMap<String, String> = BTreeMap::new();
            for folder in folders {
                if next(2) == 0 {
                    main.insert(rule_path(folder), texts[next(texts.len())].to_owned());
                }
            }
            // Respell a or a/x, moving every rule under it.
            let (from, to) = if next(2) == 0 {
                ("a", "A")
            } else {
                ("a/x", "a/X")
            };
            let mut after = main.clone();
            for (path, text) in &main {
                if let Some(rest) = path.strip_prefix(&format!("{from}/")) {
                    after.remove(path);
                    after.insert(format!("{to}/{rest}"), text.clone());
                }
            }
            if next(4) == 0 {
                // Change a moved rule too.
                if let Some(path) = after
                    .keys()
                    .find(|path| path.starts_with(&format!("{to}/")))
                    .cloned()
                {
                    after.insert(path, texts[next(texts.len())].to_owned());
                }
            }
            if next(2) == 0 {
                // Change a rule elsewhere: the root, b, or a/y.
                let other = ["", "b", "a/y"][next(3)];
                after.insert(rule_path(other), texts[next(texts.len())].to_owned());
            }
            let before: BTreeMap<String, Vec<u8>> = main
                .iter()
                .map(|(path, text)| (path.clone(), text.as_bytes().to_vec()))
                .collect();
            let changes: Vec<(String, Option<String>)> = after
                .iter()
                .filter(|(path, text)| main.get(*path) != Some(*text))
                .map(|(path, text)| (path.clone(), Some(text.clone())))
                .chain(
                    main.keys()
                        .filter(|path| !after.contains_key(*path))
                        .map(|path| (path.clone(), None)),
                )
                .collect();
            let steps: Vec<(&str, Option<&str>)> = changes
                .iter()
                .map(|(path, text)| (path.as_str(), text.as_deref()))
                .collect();
            let folded = folded_steps(&[&main, &after], &steps);
            let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &folded)
            else {
                continue;
            };
            ordered += 1;
            if !folded.is_empty() {
                respelled_ordered += 1;
            }
            let order = planned(&steps, &writes, &deletes);
            assert_eq!(
                widening_in_steps(&before, &order, &points),
                None,
                "{main:?} -> {after:?}"
            );
            for upto in 0..order.len() {
                let state = texts_after(&before, &order, upto);
                let middle: BTreeMap<String, Vec<u8>> = state
                    .iter()
                    .map(|(path, text)| (path.clone(), text.as_bytes().to_vec()))
                    .collect();
                let folded = folded_steps(&[&state, &after], &order[upto..]);
                assert!(
                    checked(&middle, &order[upto..], &folded),
                    "{main:?} -> {after:?} from step {upto}"
                );
            }
        }
        assert!(
            ordered > 300 && respelled_ordered > 100,
            "{ordered} {respelled_ordered}"
        );
    }

    fn rule_in(folder: &str) -> String {
        if folder.is_empty() {
            "access.yaml".to_owned()
        } else {
            format!("{folder}/access.yaml")
        }
    }

    /// Opus's cases from review. No version spells `team` or `a/x`, but a
    /// member can make either. The relay hides it while the twin's rule
    /// leaves members out, and otherwise gives it the level above, not the
    /// twin's. Writing the twin's rule first showed it at Edit, where members
    /// had nothing before and View after. The narrowing above goes first.
    #[test]
    fn a_folder_no_version_spells_is_judged_by_its_twins_hide() {
        for (twin, above, spelled) in [("Team", "", "team"), ("a\u{ff0f}x", "a", "a/x")] {
            let (twin_rule, above_rule) = (rule_in(twin), rule_in(above));
            let before = rule_files(&[(&twin_rule, "people:\n"), (&above_rule, "members: edit\n")]);
            let steps = [
                (twin_rule.as_str(), Some(VIEW_TEXT)),
                (above_rule.as_str(), Some(VIEW_TEXT)),
            ];
            assert!(
                widening_in_steps(&before, &steps, &[spelled]).is_some(),
                "{twin}"
            );
            assert!(!checked(&before, &steps, &[]), "{twin}");
            let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &[]) else {
                panic!("no order for {twin}");
            };
            assert_eq!(writes, [1, 0], "{twin}");
            let order = planned(&steps, &writes, &deletes);
            assert_eq!(
                widening_in_steps(&before, &order, &[spelled]),
                None,
                "{twin}"
            );
            assert!(checked(&before, &order, &[]), "{twin}");
        }
    }

    /// A folder no version spells can pass through two step folders' key
    /// groups and skip the one above them. `q／team/sub` passes `q/team` and
    /// `q/team/sub` but not `q`. It is hidden before, by `q/team`, and after,
    /// by `q/team/sub`. Writing `q`, then `q/team`, shows it at Edit, while
    /// `q`'s new rule hides every folder a version spells under `q`.
    #[test]
    fn a_folder_no_version_spells_is_judged_by_two_twins_at_once() {
        let before = rule_files(&[
            ("access.yaml", "members: edit\n"),
            ("q/access.yaml", "members: edit\n"),
            ("q/team/access.yaml", "people:\n"),
            ("q/team/sub/access.yaml", VIEW_TEXT),
        ]);
        let steps = [
            ("q/access.yaml", Some("people:\n")),
            ("q/team/access.yaml", Some(VIEW_TEXT)),
            ("q/team/sub/access.yaml", Some("people:\n")),
        ];
        let absent = ["q\u{ff0f}team/sub"];
        assert!(
            relay_reach::widening(
                &texts(&before),
                &texts_after(&before, &steps, 2),
                &texts_after(&before, &steps, 3),
                &absent
            )
            .is_some()
        );
        assert!(!checked(&before, &steps, &[]));
        let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &[]) else {
            panic!("no order");
        };
        let order = planned(&steps, &writes, &deletes);
        assert_eq!(widening_in_steps(&before, &order, &absent), None);
        assert!(checked(&before, &order, &[]));
    }

    /// Every spelling of `key` with each `/` kept or written as U+FF0F
    /// FULLWIDTH SOLIDUS, and its first letter in either case.
    fn spellings(key: &str) -> Vec<String> {
        let mut upper = key.to_owned();
        upper[..1].make_ascii_uppercase();
        let mut spelled = vec![key.to_owned(), upper];
        // From the last `/`, so each one's place is still its place in `key`.
        for slash in key.match_indices('/').map(|(slash, _)| slash).rev() {
            let other: Vec<String> = spelled
                .iter()
                .map(|name| format!("{}\u{ff0f}{}", &name[..slash], &name[slash + 1..]))
                .collect();
            spelled.extend(other);
        }
        spelled
    }

    /// Another spelling of `folder`'s rule file. Beside the first, the two
    /// are one rule nobody can read.
    fn second_rule_in(folder: &str) -> String {
        rule_in(folder).replace("access.yaml", "ACCESS.yaml")
    }

    /// Small pseudo-random rule changes in folders whose names fold to other
    /// depths, some holding two rule files, judged with the relay's reach
    /// after every step on every spelling of every folder, most of which no
    /// version holds. Each order the planner gives, and each order the check
    /// accepts, reaches no more there than before and after.
    #[test]
    fn generated_changes_never_reach_more_on_a_spelling_no_version_holds() {
        let texts = [
            VIEW_TEXT,
            "members: edit\n",
            "people:\n",
            "people:\n  p@example.com: edit\n",
            "members: comment\npeople:\n  p@example.com: view\n",
        ];
        let folders = [
            "",
            "a",
            "a\u{ff0f}x",
            "a\u{ff0f}x/y",
            "Team",
            "Team/sub",
            "q",
            "q/t",
            "q/t/s",
        ];
        let keys = ["a", "a/x", "a/x/y", "team", "team/sub", "q", "q/t", "q/t/s"];
        let spelled: Vec<String> = keys.iter().flat_map(|key| spellings(key)).collect();
        let points: Vec<&str> = spelled.iter().map(String::as_str).collect();
        let mut seed: u64 = 0xab5e;
        let mut next = |bound: usize| {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from(seed >> 33).unwrap() % bound
        };
        let (mut ordered, mut refused, mut accepted) = (0, 0, 0);
        for _ in 0..400 {
            let mut main: BTreeMap<String, String> = BTreeMap::new();
            for folder in folders {
                if next(2) == 0 {
                    main.insert(rule_in(folder), texts[next(texts.len())].to_owned());
                }
                if next(6) == 0 {
                    main.insert(second_rule_in(folder), texts[next(texts.len())].to_owned());
                }
            }
            let mut after = main.clone();
            for _ in 0..2 + next(2) {
                let folder = folders[next(folders.len())];
                let path = if next(4) == 0 {
                    second_rule_in(folder)
                } else {
                    rule_in(folder)
                };
                if after.contains_key(&path) && next(4) == 0 {
                    after.remove(&path);
                } else {
                    after.insert(path, texts[next(texts.len())].to_owned());
                }
            }
            let before: BTreeMap<String, Vec<u8>> = main
                .iter()
                .map(|(path, text)| (path.clone(), text.as_bytes().to_vec()))
                .collect();
            let changes: Vec<(String, Option<String>)> = after
                .iter()
                .filter(|(path, text)| main.get(*path) != Some(*text))
                .map(|(path, text)| (path.clone(), Some(text.clone())))
                .chain(
                    main.keys()
                        .filter(|path| !after.contains_key(*path))
                        .map(|path| (path.clone(), None)),
                )
                .collect();
            let steps: Vec<(&str, Option<&str>)> = changes
                .iter()
                .map(|(path, text)| (path.as_str(), text.as_deref()))
                .collect();
            let folded = folded_steps(&[&main, &after], &steps);
            // Every order the check accepts, of the steps as given and
            // reversed, keeps everyone within bounds.
            let mut reversed = steps.clone();
            reversed.reverse();
            for given in [&steps, &reversed] {
                if checked(&before, given, &folded) {
                    accepted += 1;
                    assert_eq!(
                        widening_in_steps(&before, given, &points),
                        None,
                        "{main:?} -> {after:?} in {given:?}"
                    );
                } else if widening_in_steps(&before, given, &points).is_some() {
                    refused += 1;
                }
            }
            let RuleFileOrder::Safe { writes, deletes } = plan_steps(&before, &steps, &folded)
            else {
                continue;
            };
            ordered += 1;
            let order = planned(&steps, &writes, &deletes);
            assert_eq!(
                widening_in_steps(&before, &order, &points),
                None,
                "{main:?} -> {after:?}"
            );
        }
        assert!(
            ordered > 300 && accepted > 500 && refused > 50,
            "{ordered} {accepted} {refused}"
        );
    }

    fn named_people(prefix: &str, count: usize) -> String {
        let mut text = String::from("members: view\npeople:\n");
        for index in 0..count {
            text.push_str(&format!("  {prefix}{index}@example.com: view\n"));
        }
        text
    }

    /// Sol's case from review: two rule changes, with 128 unchanged ruled
    /// folders below them, each naming 1,000 people. Each point keeps bounds
    /// only for the people a rule at or above it names, so the order is
    /// found, where before it built 16.6 million bounds and gave up.
    #[test]
    fn unchanged_ruled_folders_below_two_rule_changes_cost_only_their_own_people() {
        let siblings: Vec<(String, String)> = (0..128)
            .map(|index| {
                (
                    format!("z{index}/access.yaml"),
                    named_people(&format!("z{index}-"), 1_000),
                )
            })
            .collect();
        let mut files: Vec<(&str, &str)> = vec![("access.yaml", VIEW_TEXT)];
        files.extend(
            siblings
                .iter()
                .map(|(path, text)| (path.as_str(), text.as_str())),
        );
        let before = rule_files(&files);
        let started = std::time::Instant::now();
        let order = plan(
            &before,
            &[
                ("access.yaml", "members: comment\n"),
                ("new/access.yaml", VIEW_TEXT),
            ],
        );
        eprintln!("128 folders of 1,000 people: {:?}", started.elapsed());
        assert_eq!(safe_writes(order), [1, 0]);
    }

    /// Opus's case from review: a Version makes 60 sibling folders private,
    /// each naming two people, with or without narrowing the root. Every
    /// folder is a twin under the root, and one anchor holding all 60 cost
    /// about the square of their count for each. No two of them are on one
    /// key chain, so each is judged apart.
    #[test]
    fn making_many_sibling_folders_private_is_ordered() {
        let paths: Vec<String> = (0..60)
            .map(|index| format!("team{index}/access.yaml"))
            .collect();
        let texts: Vec<String> = (0..60)
            .map(|index| {
                format!(
                    "people:
  a{index}@example.com: edit
  b{index}@example.com: edit
"
                )
            })
            .collect();
        let mut files = vec![(
            "access.yaml",
            "members: edit
",
        )];
        files.extend(paths.iter().map(|path| (path.as_str(), VIEW_TEXT)));
        let before = rule_files(&files);
        let mut writes: Vec<(&str, &str)> = paths
            .iter()
            .zip(&texts)
            .map(|(path, text)| (path.as_str(), text.as_str()))
            .collect();
        for root in [false, true] {
            if root {
                writes.push(("access.yaml", VIEW_TEXT));
            }
            let started = std::time::Instant::now();
            let order = safe_writes(plan(&before, &writes));
            eprintln!(
                "60 folders made private, root {root}: {:?}",
                started.elapsed()
            );
            // The merge's own check of that order fits the allowance too.
            let steps: Vec<(&str, Option<&str>)> = in_order(&writes, &order)
                .into_iter()
                .map(|(path, text)| (path, Some(text)))
                .collect();
            assert!(checked(&before, &steps, &[]), "root {root}");
        }
    }

    /// Preparing the bounds takes its share of the work before it keeps
    /// anything, so a change too large to prepare is refused before it is.
    #[test]
    fn preparing_an_order_charges_its_work_before_it_keeps_anything() {
        let siblings: Vec<(String, String)> = (0..128)
            .map(|index| {
                (
                    format!("z{index}/access.yaml"),
                    named_people(&format!("z{index}-"), 100),
                )
            })
            .collect();
        let mut files: Vec<(&str, &str)> = vec![("access.yaml", VIEW_TEXT)];
        files.extend(
            siblings
                .iter()
                .map(|(path, text)| (path.as_str(), text.as_str())),
        );
        let before = rule_files(&files);
        let steps = [
            RuleFileStep::Write("access.yaml", b"members: comment\n"),
            RuleFileStep::Write("new/access.yaml", b"members: view\n"),
        ];
        // Reading has its own share, so this measures preparing alone.
        let prepared = |work: usize| {
            with_steps(
                &before,
                &steps,
                &mut RuleOrderWork::default(),
                |start, steps, _| {
                    Change::new(start, &steps, &[0, 1], &mut RuleOrderWork(work))
                        .map(|change| change.bounds.len())
                },
            )
            .flatten()
        };
        assert_eq!(prepared(10_000), None);
        assert!(prepared(RULE_ORDER_WORK).is_some_and(|bounds| bounds > 10_000));
        assert!(matches!(
            safe_rule_file_order(
                &before,
                &steps,
                &[],
                &BTreeSet::new(),
                &mut RuleOrderWork(10_000)
            ),
            RuleFileOrder::TooMany { writes, .. } if writes == [0, 1]
        ));
    }

    /// Sol's case from review, smaller: 64 folders respelled from `Team{i}`
    /// to `team{i}`, each rule naming 1,000 people. Reading the rules takes
    /// its work before it keeps each one, and telling whether the steps only
    /// respell takes its work before it groups and compares them, so either
    /// runs out before anything larger is kept.
    #[test]
    fn reading_and_respelling_charge_their_work_before_they_keep_anything() {
        let texts: Vec<(String, String, String)> = (0..64)
            .map(|index| {
                (
                    format!("Team{index}/access.yaml"),
                    format!("team{index}/access.yaml"),
                    named_people(&format!("t{index}-"), 1_000),
                )
            })
            .collect();
        let before = rule_files(
            &texts
                .iter()
                .map(|(old, _, text)| (old.as_str(), text.as_str()))
                .collect::<Vec<_>>(),
        );
        let steps: Vec<(&str, Option<&str>)> = texts
            .iter()
            .map(|(_, new, text)| (new.as_str(), Some(text.as_str())))
            .chain(texts.iter().map(|(old, _, _)| (old.as_str(), None)))
            .collect();
        let folded: BTreeSet<String> = steps.iter().map(|(path, _)| (*path).to_owned()).collect();
        let rule_steps: Vec<RuleFileStep<'_>> = steps.iter().map(rule_step).collect();
        let (writes, deletes) = rule_steps.split_at(texts.len());
        let order = |work: &mut RuleOrderWork| {
            safe_rule_file_order(&before, writes, deletes, &folded, work)
        };
        let mut all = RuleOrderWork::default();
        assert!(matches!(order(&mut all), RuleFileOrder::Safe { .. }));
        let ordering = RULE_ORDER_WORK - all.0;
        // Reading the 128 rules takes their bytes and their 128,000 people.
        let mut read = RuleOrderWork::default();
        with_steps(&before, &rule_steps, &mut read, |_, _, _| ()).expect("read");
        let reading = RULE_ORDER_WORK - read.0;
        assert!(reading > 128_000, "{reading}");
        let mut short = RuleOrderWork(reading - 1);
        assert!(with_steps(&before, &rule_steps, &mut short, |_, _, _| ()).is_none());
        assert!(matches!(
            order(&mut RuleOrderWork(reading - 1)),
            RuleFileOrder::TooMany { writes, deletes } if writes.len() == 64 && deletes.len() == 64
        ));
        // Grouping the steps and comparing every rule's people takes about
        // as much again, before any of it is kept.
        assert!(ordering - reading > 128_000, "{ordering} after {reading}");
        assert!(matches!(
            order(&mut RuleOrderWork(ordering - 1)),
            RuleFileOrder::TooMany { .. }
        ));
    }

    /// The check each rule merge makes stops at the same limit: 64 nested
    /// folders each naming 1,000 people, under a root rule that changes.
    #[test]
    fn checking_an_order_stops_at_the_work_limit() {
        let folders: Vec<String> = (1..=64)
            .map(|depth| {
                (0..depth)
                    .map(|level| format!("n{level}"))
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect();
        let nested: Vec<(String, String)> = folders
            .iter()
            .enumerate()
            .map(|(index, folder)| {
                (
                    format!("{folder}/access.yaml"),
                    named_people(&format!("n{index}-"), 1_000),
                )
            })
            .collect();
        let files: Vec<(&str, &str)> = nested
            .iter()
            .map(|(path, text)| (path.as_str(), text.as_str()))
            .collect();
        let before = rule_files(&files);
        let deep = format!("{}/new/access.yaml", folders[63]);
        let steps = [
            RuleFileStep::Write(&deep, b"members: view\n"),
            RuleFileStep::Write("access.yaml", b"members: view\n"),
        ];
        let started = std::time::Instant::now();
        assert!(!rule_file_order_is_safe(
            &before,
            &steps,
            &BTreeSet::new(),
            &mut RuleOrderWork::default()
        ));
        eprintln!("64 nested folders of 1,000 people: {:?}", started.elapsed());
        // One step alone needs no order, so it is never refused.
        assert!(rule_file_order_is_safe(
            &before,
            &steps[1..],
            &BTreeSet::new(),
            &mut RuleOrderWork::default()
        ));
    }

    /// Opus's case from review: a tangled pair and twenty sibling rules
    /// under one folder, 22 steps, use up the search's work.
    #[test]
    fn a_search_of_64_steps_or_fewer_that_uses_up_its_work_says_so() {
        let before = rule_files(&[]);
        let others: Vec<String> = (0..20)
            .map(|index| format!("team/a{index}/access.yaml"))
            .collect();
        let mut writes = vec![
            ("team/access.yaml", "people:\n  p@example.com: edit\n"),
            (
                "team/sub/access.yaml",
                "members: edit\npeople:\n  p@example.com: view\n",
            ),
        ];
        writes.extend(others.iter().map(|path| (path.as_str(), VIEW_TEXT)));
        let started = std::time::Instant::now();
        let order = plan(&before, &writes);
        eprintln!("22 tangled steps: {:?}", started.elapsed());
        assert!(matches!(order, RuleFileOrder::TooMany { writes, .. } if writes.len() == 22));
    }
}
