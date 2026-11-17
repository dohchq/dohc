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

/// Rule files by path; `None` is one that can't be read.
type RuleFiles<'a> = BTreeMap<&'a str, Option<AccessRule>>;

/// Each ruled folder's rule. Two files in one folder are one unreadable rule.
fn folder_rules<'a>(files: &'a RuleFiles<'_>) -> BTreeMap<&'a str, Option<&'a AccessRule>> {
    let mut folders: BTreeMap<&str, Option<&AccessRule>> = BTreeMap::new();
    for (path, rule) in files {
        folders
            .entry(access_rule_folder(path))
            .and_modify(|twice| *twice = None)
            .or_insert(rule.as_ref());
    }
    folders
}

/// What a member reaches in `folder`, as the relay's `folderLevel` reads it:
/// rules apply from the root down, each replaces the level above, and one
/// that leaves the member out hides everything below. `email` is a person a
/// rule names, or `None` for a member none names.
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

/// A rule file a change of many paths writes, with its bytes, or deletes.
#[derive(Clone, Copy, Debug)]
pub enum RuleFileStep<'a> {
    Write(&'a str, &'a [u8]),
    Delete(&'a str),
}

fn parsed(bytes: &[u8]) -> Option<AccessRule> {
    std::str::from_utf8(bytes).ok().and_then(parse_access_rule)
}

fn apply<'a>(files: &mut RuleFiles<'a>, step: RuleFileStep<'a>) {
    match step {
        RuleFileStep::Write(path, bytes) => {
            files.insert(path, parsed(bytes));
        }
        RuleFileStep::Delete(path) => {
            files.remove(path);
        }
    }
}

/// Searching every order is exponential; past this many steps, only the
/// order given is tried.
const MAX_SEARCHED_RULE_STEPS: usize = 16;

/// An order for writing, then deleting, many rule files one at a time, in
/// which no step gives any member more anywhere than both the rules before
/// and the rules after give them. Each phase is a list of indexes into its
/// steps, and tries the order given first. `None` when no such order exists.
///
/// `before` is every rule file before the change. Files merge between the
/// two phases, so the state after the writes must stay within bounds too.
pub fn safe_rule_file_order<'a>(
    before: &'a BTreeMap<String, Vec<u8>>,
    writes: &[RuleFileStep<'a>],
    deletes: &[RuleFileStep<'a>],
) -> Option<(Vec<usize>, Vec<usize>)> {
    let start: RuleFiles<'a> = before
        .iter()
        .map(|(path, bytes)| (path.as_str(), parsed(bytes)))
        .collect();
    let mut end = start.clone();
    for step in writes.iter().chain(deletes) {
        apply(&mut end, *step);
    }
    let emails: BTreeSet<&str> = start
        .values()
        .chain(end.values())
        .flatten()
        .flat_map(|rule| rule.people.keys().map(String::as_str))
        .collect();
    let people: Vec<Option<&str>> = std::iter::once(None)
        .chain(emails.into_iter().map(Some))
        .collect();
    let points: BTreeSet<&str> = std::iter::once("")
        .chain(
            start
                .keys()
                .chain(end.keys())
                .map(|path| access_rule_folder(path)),
        )
        .collect();
    let (start_rules, end_rules) = (folder_rules(&start), folder_rules(&end));
    let bounds: Vec<(&str, Option<&str>, Reach, Reach)> = points
        .iter()
        .flat_map(|point| people.iter().map(move |email| (*point, *email)))
        .map(|(point, email)| {
            (
                point,
                email,
                reach_in(&start_rules, point, email),
                reach_in(&end_rules, point, email),
            )
        })
        .collect();
    let safe = |files: &RuleFiles<'_>| {
        let rules = folder_rules(files);
        bounds.iter().all(|(point, email, before, after)| {
            let reach = reach_in(&rules, point, *email);
            reach.within(*before) || reach.within(*after)
        })
    };
    let mut middle = start.clone();
    let write_order = phase_order(&mut middle, writes, &safe)?;
    let delete_order = phase_order(&mut middle, deletes, &safe)?;
    Some((write_order, delete_order))
}

/// Finds an order of `steps` from `files` in which every state is `safe`,
/// and leaves `files` as the state after all of them.
fn phase_order<'a>(
    files: &mut RuleFiles<'a>,
    steps: &[RuleFileStep<'a>],
    safe: &impl Fn(&RuleFiles<'_>) -> bool,
) -> Option<Vec<usize>> {
    if steps.len() > MAX_SEARCHED_RULE_STEPS {
        for step in steps {
            apply(files, *step);
            if !safe(files) {
                return None;
            }
        }
        return Some((0..steps.len()).collect());
    }
    let mut order = Vec::with_capacity(steps.len());
    let mut failed = BTreeSet::new();
    if !search(files, 0, steps, safe, &mut failed, &mut order) {
        return None;
    }
    for &index in &order {
        apply(files, steps[index]);
    }
    Some(order)
}

fn search<'a>(
    files: &RuleFiles<'a>,
    done: u32,
    steps: &[RuleFileStep<'a>],
    safe: &impl Fn(&RuleFiles<'_>) -> bool,
    failed: &mut BTreeSet<u32>,
    order: &mut Vec<usize>,
) -> bool {
    if order.len() == steps.len() {
        return true;
    }
    if failed.contains(&done) {
        return false;
    }
    for (index, step) in steps.iter().enumerate() {
        if done & (1 << index) != 0 {
            continue;
        }
        let mut next = files.clone();
        apply(&mut next, *step);
        if !safe(&next) {
            continue;
        }
        order.push(index);
        if search(&next, done | (1 << index), steps, safe, failed, order) {
            return true;
        }
        order.pop();
    }
    failed.insert(done);
    false
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

    #[derive(serde::Deserialize)]
    struct Vectors {
        parsed: Vec<Parsed>,
        narrowing: Vec<Narrowing>,
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

    fn rule_files(files: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        files
            .iter()
            .map(|(path, text)| {
                assert!(parse_access_rule(text).is_some(), "{path} reads");
                ((*path).to_owned(), text.as_bytes().to_vec())
            })
            .collect()
    }

    /// Each member's reach after every write, the first included, stays
    /// within what the rules before or after give them.
    fn each_write_stays_within(
        before: &BTreeMap<String, Vec<u8>>,
        writes: &[(&str, &str)],
        people: &[Option<&str>],
    ) -> bool {
        let start: RuleFiles<'_> = before
            .iter()
            .map(|(path, bytes)| (path.as_str(), parsed(bytes)))
            .collect();
        let mut states = vec![start];
        for (path, text) in writes {
            let mut next = states.last().expect("a state").clone();
            apply(&mut next, RuleFileStep::Write(path, text.as_bytes()));
            states.push(next);
        }
        let all_rules: Vec<_> = states.iter().map(folder_rules).collect();
        let (first, last) = (&all_rules[0], &all_rules[all_rules.len() - 1]);
        let points: BTreeSet<&str> = all_rules
            .iter()
            .flat_map(|rules| rules.keys().copied())
            .chain([""])
            .collect();
        all_rules.iter().all(|rules| {
            points.iter().all(|point| {
                people.iter().all(|email| {
                    let reach = reach_in(rules, point, *email);
                    reach.within(reach_in(first, point, *email))
                        || reach.within(reach_in(last, point, *email))
                })
            })
        })
    }

    fn plan(before: &BTreeMap<String, Vec<u8>>, writes: &[(&str, &str)]) -> Option<Vec<usize>> {
        let steps: Vec<_> = writes
            .iter()
            .map(|(path, text)| RuleFileStep::Write(path, text.as_bytes()))
            .collect();
        safe_rule_file_order(before, &steps, &[]).map(|(writes, deletes)| {
            assert!(deletes.is_empty());
            writes
        })
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
        assert!(!each_write_stays_within(&before, &writes, &[None]));
        let order = plan(&before, &writes).expect("a safe order");
        assert_eq!(order, [1, 0]);
        let ordered: Vec<_> = order.iter().map(|&index| writes[index]).collect();
        assert!(each_write_stays_within(&before, &ordered, &[None]));
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
        assert!(!each_write_stays_within(&before, &writes, &[None]));
        let order = plan(&before, &writes).expect("a safe order");
        assert_eq!(order, [1, 0]);
        let ordered: Vec<_> = order.iter().map(|&index| writes[index]).collect();
        assert!(each_write_stays_within(&before, &ordered, &[None]));
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
        let reversed = [writes[1], writes[0]];
        assert!(!each_write_stays_within(&before, &reversed, &[None]));
        assert_eq!(plan(&before, &writes), Some(vec![0, 1]));
        assert!(each_write_stays_within(&before, &writes, &[None]));
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
        let people = [None, Some("p@example.com")];
        assert!(!each_write_stays_within(&before, &writes, &people));
        assert!(!each_write_stays_within(
            &before,
            &[writes[1], writes[0]],
            &people
        ));
        assert_eq!(plan(&before, &writes), None);
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
            Some((vec![0], vec![0]))
        );
    }
}
