use super::*;

// Generated cases: dohc's syntax and ordinary inline Markdown inside marks
// and containers, on one line and over two. Each case is read, written and
// read again: the document and the file stay the same, nothing grows over
// five saves, no text is lost, and a container reads its text as a
// paragraph does. The full run writes a report to compare with another
// build's; the gate checks a fixed sample.
mod generated {
    use super::*;
    use std::collections::HashMap;

    const CONSTRUCTS: &[(&str, &str, &str)] = &[
        ("formula", "$$qx=qy$$", "$$qx=qy\nqz$$"),
        ("highlight", "==qh==", "==qh\nqk=="),
        ("underline", "++qu++", "++qu\nqv++"),
        ("wikilink", "[[Qnote]]", "qw\n[[Qnote]]"),
        ("atom", "{{atom:qa}}", "qw\n{{atom:qa}}"),
        ("www", "www.qe.com", "qw\nwww.qe.com"),
        ("http", "https://qe.com/qp", "qw\nhttps://qe.com/qp"),
        ("email", "qm@qe.co", "qw\nqm@qe.co"),
        ("link", "[qt](qv)", "[qt\nqw](qv)"),
        ("code", "`qc=qd`", "`qc\nqd`"),
        ("tag", "<x>qt</x>", "<x>qt\nqw</x>"),
        ("star", "q2*q3", "qw\nq2*q3"),
        ("underscore", "qa_qb", "qw\nqa_qb"),
        ("equals", "qp=qq", "qw\nqp=qq"),
        ("escaped-equals", "qp\\=qq", "qw\nqp\\=qq"),
        ("plus", "qp+qq", "qw\nqp+qq"),
        ("dollar", "$q5", "qw\n$q5"),
        ("backslash", "qa\\qb", "qw\nqa\\qb"),
        // Two that interact: a pair beside an escape a mark decodes.
        ("underline-equals", "qa++qu++=qv", "qa++qu++=qv\nqd"),
        ("highlight-plus", "qa==qh==+qv", "qa==qh==+qv\nqd"),
        ("inline-math", "$qx$", "qw\n$qx$"),
        ("escaped-star", "qa\\*qb", "qw\nqa\\*qb"),
        ("hard-break", "qa\\\nqb", "qa  \nqb"),
        ("image", "![qi](qv)", "qw\n![qi](qv)"),
        ("strike", "~~qs~~", "~~qs\nqt~~"),
        ("autolink", "<https://qe.com>", "qw\n<https://qe.com>"),
        ("entity", "qa&amp;qb", "qw\nqa&amp;qb"),
        // Delimiters that open nothing, or pair over a line.
        ("open-equals", "qa ==qb", "qa ==qb\nqd"),
        ("lone-equals", "qa == qb", "qa\n== qb"),
        ("open-plus", "qa ++qb", "qa ++qb\nqd"),
        ("escaped-underscore", "qa\\_qb", "qw\nqa\\_qb"),
        ("escape-first", "\\*qa", "\\*qa\n\\_qb"),
        // Delimiter runs that pair only in part, and literal brackets.
        ("unbalanced-star", "**qa* qb", "**qa\nqb* qc"),
        ("triple-star", "***qa**", "***qa\nqb**"),
        ("lone-star", "qa * qb", "qa *\nqb"),
        ("unbalanced-underscore", "__qa_ qb", "__qa\nqb_ qc"),
        ("tilde-run", "~~~qa~~", "qw\n~~~qa~~"),
        ("brackets", "[qa] qb", "[qa]\nqb"),
    ];

    // Marks, and the constructs that hold text: each wraps each construct,
    // alone or inside another.
    const MARKS: &[(&str, &str, &str)] = &[
        ("bold", "**", "**"),
        ("italic", "*", "*"),
        ("linktext", "[", "](qu)"),
        ("highlight", "==", "=="),
        ("underline", "++", "++"),
        ("strike", "~~", "~~"),
        ("formula", "$$", "$$"),
        ("tag", "<x>", "</x>"),
        ("code", "`", "`"),
    ];

    struct Container {
        name: &'static str,
        before: &'static str,
        first: &'static str,
        rest: &'static str,
        end: &'static str,
        two_lines: bool,
        skip: usize,
    }

    #[rustfmt::skip]
    const CONTAINERS: &[Container] = &[
        Container { name: "paragraph", before: "", first: "", rest: "", end: "", two_lines: true, skip: 0 },
        Container { name: "quote", before: "", first: "> ", rest: "> ", end: "", two_lines: true, skip: 0 },
        Container { name: "nested-quote", before: "", first: "> > ", rest: "> > ", end: "", two_lines: true, skip: 0 },
        Container { name: "list", before: "", first: "- ", rest: "  ", end: "", two_lines: true, skip: 0 },
        Container { name: "nested-list", before: "- qr\n", first: "  - ", rest: "    ", end: "", two_lines: true, skip: 1 },
        Container { name: "cell", before: "| qh |\n|---|\n", first: "| ", rest: "", end: " |", two_lines: false, skip: 1 },
        Container { name: "callout", before: "> [!note]\n", first: "> ", rest: "> ", end: "", two_lines: true, skip: 0 },
        Container { name: "heading", before: "", first: "# ", rest: "", end: "", two_lines: false, skip: 0 },
        Container { name: "indented", before: "", first: " ", rest: "", end: "", two_lines: true, skip: 0 },
        Container { name: "indented-item", before: "- qr\n\n", first: "   ", rest: "  ", end: "", two_lines: true, skip: 1 },
    ];

    pub(super) struct Case {
        pub id: String,
        pub inline: String,
        pub source: String,
        pub skip: usize,
        /// Whether the container can hold a block, such as a math block.
        /// A heading or a cell holds one line of text and no blocks.
        pub holds_blocks: bool,
        /// Whether the first line is indented past its container, which the
        /// editor keeps as leading spaces.
        pub indented: bool,
    }

    fn wrappings() -> Vec<(String, Vec<usize>)> {
        let mut all = vec![("none".to_owned(), Vec::new())];
        for (index, mark) in MARKS.iter().enumerate() {
            all.push((mark.0.to_owned(), vec![index]));
        }
        for (outer, outer_mark) in MARKS.iter().enumerate() {
            for (inner, inner_mark) in MARKS.iter().enumerate() {
                if outer != inner {
                    all.push((
                        format!("{}>{}", outer_mark.0, inner_mark.0),
                        vec![outer, inner],
                    ));
                }
            }
        }
        // Two marks around a construct that holds text: the first six are
        // marks, the rest hold text.
        let (marks, holders) = MARKS.split_at(6);
        for (outer, outer_mark) in marks.iter().enumerate() {
            for (middle, middle_mark) in marks.iter().enumerate() {
                for (inner, inner_mark) in holders.iter().enumerate() {
                    if outer != middle {
                        let name = format!("{}>{}>{}", outer_mark.0, middle_mark.0, inner_mark.0);
                        all.push((name, vec![outer, middle, marks.len() + inner]));
                    }
                }
            }
        }
        all
    }

    pub(super) fn cases() -> Vec<Case> {
        let mut cases = Vec::new();
        for (name, one, two) in CONSTRUCTS {
            for (lines, construct) in [("1", *one), ("2", *two)] {
                for (pad, body) in [
                    ("tight", construct.to_owned()),
                    ("padded", format!("qa {construct} qb")),
                ] {
                    for (wrap_name, wrap) in wrappings() {
                        let mut inline = body.clone();
                        for &mark in wrap.iter().rev() {
                            inline = format!("{}{}{}", MARKS[mark].1, inline, MARKS[mark].2);
                        }
                        for container in CONTAINERS {
                            if inline.contains('\n') && !container.two_lines {
                                continue;
                            }
                            let mut source = container.before.to_owned();
                            for (index, line) in inline.split('\n').enumerate() {
                                if index > 0 {
                                    source.push('\n');
                                    source.push_str(container.rest);
                                } else {
                                    source.push_str(container.first);
                                }
                                source.push_str(line);
                            }
                            source.push_str(container.end);
                            source.push('\n');
                            cases.push(Case {
                                id: format!("{name}/{lines}/{pad}/{wrap_name}/{}", container.name),
                                inline: inline.clone(),
                                source,
                                skip: container.skip,
                                holds_blocks: container.two_lines,
                                indented: container.name.starts_with("indented"),
                            });
                        }
                    }
                }
            }
        }
        cases
    }

    pub(super) fn read(source: &str) -> Option<(Value, String)> {
        let source = source.to_owned();
        std::panic::catch_unwind(move || {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
                .ok()?;
            let body = doc.canonical_content()["body"].clone();
            let written = doc.project_richdoc().ok()?;
            Some((body, written))
        })
        .ok()
        .flatten()
    }

    const BLOCKS: &[&str] = &[
        "paragraph",
        "heading",
        "blockquote",
        "bulletList",
        "orderedList",
        "listItem",
        "callout",
        "table",
        "tableRow",
        "tableHeader",
        "tableCell",
        "taskList",
        "taskItem",
    ];

    fn leaves(node: &Value, out: &mut Vec<Value>) {
        match node["type"].as_str() {
            Some("xmlText") => {
                for item in node["delta"].as_array().into_iter().flatten() {
                    if let Some(Value::Object(last)) = out.last_mut() {
                        if last.contains_key("insert") && last.get("attrs") == item.get("attrs") {
                            if let (Some(a), Some(b)) =
                                (last["insert"].as_str(), item["insert"].as_str())
                            {
                                let joined = format!("{a}{b}");
                                last.insert("insert".to_owned(), Value::from(joined));
                                continue;
                            }
                        }
                    }
                    out.push(item.clone());
                }
            }
            Some("element") if BLOCKS.contains(&node["tag"].as_str().unwrap_or_default()) => {
                for child in node["children"].as_array().into_iter().flatten() {
                    leaves(child, out);
                }
            }
            Some("xmlFragment") => {
                for child in node["children"].as_array().into_iter().flatten() {
                    leaves(child, out);
                }
            }
            _ => out.push(node.clone()),
        }
    }

    pub(super) fn flat(body: &Value, skip: usize) -> Vec<Value> {
        let mut out = Vec::new();
        leaves(body, &mut out);
        out.into_iter().skip(skip).collect()
    }

    fn tokens(text: &str) -> Vec<String> {
        let mut found = Vec::new();
        let bytes = text.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            if (bytes[at] == b'q' || bytes[at] == b'Q')
                && (at == 0 || !bytes[at - 1].is_ascii_alphanumeric())
            {
                let end = (at + 1..bytes.len())
                    .find(|&i| !bytes[i].is_ascii_alphanumeric())
                    .unwrap_or(bytes.len());
                found.push(text[at..end].to_owned());
                at = end;
            } else {
                at += 1;
            }
        }
        found
    }

    /// What a reading shows.
    #[derive(Default)]
    struct Shown {
        /// Its text in order. Runs of a block join as they show, and a node
        /// stands apart with its values.
        text: String,
        /// Its marks' values, such as a link's address.
        marks: String,
        /// Each run of code.
        code: Vec<String>,
    }

    impl Shown {
        fn of(body: &Value) -> Self {
            let mut shown = Self::default();
            shown.add(body);
            shown
        }

        fn add(&mut self, value: &Value) {
            match value {
                Value::Array(items) => items.iter().for_each(|item| self.add(item)),
                Value::Object(fields) => {
                    if let Some(Value::String(text)) = fields.get("insert") {
                        self.text.push_str(text);
                        if let Some(attrs) = fields.get("attrs") {
                            if attrs.get("code").is_some() {
                                self.code.push(text.clone());
                            }
                            strings(attrs, &mut self.marks);
                        }
                        return;
                    }
                    let node = fields.contains_key("tag");
                    if node {
                        self.text.push('\n');
                        if let Some(Value::Object(attrs)) = fields.get("attrs") {
                            attrs
                                .values()
                                .for_each(|value| strings(value, &mut self.text));
                        }
                    }
                    for key in ["children", "delta"] {
                        if let Some(items) = fields.get(key) {
                            self.add(items);
                        }
                    }
                    if node {
                        self.text.push('\n');
                    }
                }
                _ => {}
            }
        }

        fn words(&self) -> Vec<String> {
            let mut words = tokens(&self.text);
            words.extend(tokens(&self.marks));
            words
        }
    }

    /// Each string in `value`, each on a line of its own.
    fn strings(value: &Value, out: &mut String) {
        match value {
            Value::String(text) => {
                out.push_str(text);
                out.push('\n');
            }
            Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
            Value::Object(fields) => fields.values().for_each(|field| strings(field, out)),
            _ => {}
        }
    }

    /// Whether `found` shows each character of `wanted` outside white space,
    /// in the same order.
    fn in_order(found: &str, wanted: &str) -> bool {
        let mut found = found.chars().filter(|c| !c.is_whitespace());
        wanted
            .chars()
            .filter(|c| !c.is_whitespace())
            .all(|c| found.any(|f| f == c))
    }

    #[test]
    fn a_dropped_repeat_or_joined_words_count_as_lost() {
        let wanted = tokens("qa qa qb");
        assert!(keeps(&tokens("**qa** qa [qb](qu)"), &wanted));
        assert!(!keeps(&tokens("qa qb"), &wanted));
        assert!(!keeps(&tokens("qa qaqb"), &wanted));
        // Two runs show as one word; a node and its neighbour don't.
        let shown = Shown::of(&serde_json::json!([
            {"delta": [{"attrs": {"italic": {}, "link": {"href": "qu"}}, "insert": "q2"},
                {"attrs": {"code": {}}, "insert": "q3  q4"}]},
            {"tag": "mathInline", "attrs": {"tex": "qx"}, "children": []},
            {"delta": [{"insert": "qy"}]}
        ]));
        assert_eq!(shown.words(), ["q2q3", "q4", "qx", "qy", "qu"]);
        assert_eq!(shown.code, ["q3  q4"]);
        assert!(in_order("**q2*q3**", "q2*q3") && !in_order("q2q3*", "q2*q3"));
    }

    /// Whether `found` holds each word of `wanted` as often as `wanted` does,
    /// so a dropped repeat or two words joined into one count as lost.
    fn keeps(found: &[String], wanted: &[String]) -> bool {
        let mut left: HashMap<&str, usize> = HashMap::new();
        for word in found {
            *left.entry(word.as_str()).or_default() += 1;
        }
        wanted.iter().all(|word| match left.get_mut(word.as_str()) {
            Some(count) if *count > 0 => {
                *count -= 1;
                true
            }
            _ => false,
        })
    }

    pub(super) fn check(
        case: &Case,
        plain: &mut HashMap<String, Option<Vec<Value>>>,
    ) -> Vec<&'static str> {
        let mut fails = Vec::new();
        let Some((first, w1)) = read(&case.source) else {
            return vec!["read-error"];
        };
        let Some((second, w2)) = read(&w1) else {
            return vec!["reread-error"];
        };
        if second != first {
            fails.push("doc-changes");
        }
        if w2 != w1 {
            fails.push("second-save-changes");
        }
        let mut written = w2;
        let mut grows = false;
        for _ in 0..3 {
            match read(&written) {
                Some((_, next)) => {
                    if next != written {
                        grows = true;
                    }
                    written = next;
                }
                None => {
                    grows = true;
                    break;
                }
            }
        }
        if grows {
            fails.push("keeps-changing");
        }
        let wanted = tokens(&case.inline);
        let in_runs = |body: &Value| {
            let mut found = String::new();
            strings(body, &mut found);
            tokens(&found)
        };
        if !keeps(&in_runs(&first), &wanted) {
            fails.push("text-lost");
        }
        // A save keeps the words as the first reading shows them, so two
        // words it joins count as lost, and code keeps its white space:
        // `a  b` and `a b` are different code.
        let (before, after) = (Shown::of(&first), Shown::of(&second));
        if !keeps(&in_runs(&second), &wanted)
            || !keeps(&tokens(&written), &wanted)
            || !keeps(&after.words(), &before.words())
            || before
                .code
                .iter()
                .any(|run| !after.text.contains(run.as_str()))
        {
            fails.push("text-lost-after-save");
        }
        // Punctuation that moves or becomes a mark, as a literal `==` that
        // reads as a highlight once written.
        if !in_order(&after.text, &before.text) {
            fails.push("punctuation-changes");
        }
        let reference = plain
            .entry(case.inline.clone())
            .or_insert_with(|| read(&format!("{}\n", case.inline)).map(|(body, _)| flat(&body, 0)))
            .clone();
        if let Some(reference) = reference {
            // A container that holds no blocks can't read a block, such as a
            // math or code block, the way a paragraph does. The other checks
            // still apply.
            let block = reference.iter().any(|leaf| {
                matches!(
                    leaf["tag"].as_str(),
                    Some("mathBlock" | "codeBlock" | "horizontalRule" | "rawBlock")
                )
            });
            let mut read = flat(&first, case.skip);
            if case.indented {
                // The kept indentation is the container's, not the text's.
                if let Some(Value::Object(leaf)) = read.first_mut() {
                    if let Some(text) = leaf.get("insert").and_then(Value::as_str) {
                        let text = text.trim_start_matches(' ').to_owned();
                        if text.is_empty() {
                            read.remove(0);
                        } else {
                            leaf.insert("insert".to_owned(), Value::from(text));
                        }
                    }
                }
            }
            let sealed = |leaves: &[Value]| leaves.iter().any(|leaf| leaf["tag"] == "rawBlock");
            if block && !case.holds_blocks {
                fails.push("info:holds-no-block");
            } else if sealed(&flat(&first, 0)) && sealed(&reference) {
                fails.push("info:both-sealed");
            } else if sealed(&flat(&first, 0)) {
                // The container's whole block is kept as its source, where
                // the paragraph reads live: a cost of the seal's size.
                fails.push("container-sealed");
            } else if sealed(&reference) {
                fails.push("paragraph-sealed");
            } else if read != reference {
                fails.push("container-changes-text");
            }
        }
        fails
    }
}

/// The failures each case shows, and what the checks skipped.
fn results(
    cases: impl Iterator<Item = generated::Case>,
) -> Vec<(generated::Case, Vec<&'static str>, Vec<&'static str>)> {
    let mut plain = std::collections::HashMap::new();
    cases
        .map(|case| {
            let (info, fails) = generated::check(&case, &mut plain)
                .into_iter()
                .partition(|check| check.starts_with("info:"));
            (case, fails, info)
        })
        .collect()
}

/// Checks that mean harm: the reader refuses the note, text is lost, or the
/// file never settles. Only a case `markdown_judge_ceilings.txt` names may
/// fail one.
const HARM: [&str; 5] = [
    "read-error",
    "reread-error",
    "text-lost",
    "text-lost-after-save",
    "keeps-changing",
];

/// Holds a run's failures to `markdown_judge_ceilings.txt`: no harm outside
/// the listed cases, and each other check's count exactly at its ceiling, so
/// a ceiling can only be lowered.
fn within_ceilings(set: &str, results: &[(generated::Case, Vec<&'static str>, Vec<&'static str>)]) {
    use std::collections::{BTreeMap, BTreeSet};
    let mut ceilings = BTreeMap::new();
    let mut listed = BTreeSet::new();
    for line in include_str!("markdown_judge_ceilings.txt").lines() {
        let words: Vec<_> = line.split_whitespace().collect();
        match words.as_slice() {
            [] => {}
            [first, ..] if first.starts_with('#') => {}
            ["harm", id, check] => {
                listed.insert((id.to_string(), check.to_string()));
            }
            [run, check, count] if *run == set => {
                ceilings.insert(check.to_string(), count.parse::<usize>().expect("a count"));
            }
            [_, _, _] => {}
            _ => panic!("unreadable ceilings line {line:?}"),
        }
    }
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut harm = Vec::new();
    for (case, fails, _) in results {
        for check in fails {
            if HARM.contains(check) {
                if !listed.contains(&(case.id.clone(), check.to_string())) {
                    harm.push(format!("{} {check} {:?}", case.id, case.source));
                }
            } else {
                *counts.entry(check.to_string()).or_default() += 1;
            }
        }
    }
    let checks: BTreeSet<_> = counts.keys().chain(ceilings.keys()).cloned().collect();
    let off: Vec<_> = checks
        .into_iter()
        .filter_map(|check| {
            let (count, ceiling) = (
                counts.get(&check).copied().unwrap_or(0),
                ceilings.get(&check).copied().unwrap_or(0),
            );
            (count != ceiling).then(|| format!("{set} {check} {count} (ceiling {ceiling})"))
        })
        .collect();
    assert!(
        harm.is_empty() && off.is_empty(),
        "harm {harm:#?}\ncounts off their ceilings; above one is a regression, below one lowers it: {off:#?}"
    );
}

/// Every 37th generated case: no harm, and each check's count at its ceiling.
#[test]
fn a_sample_of_generated_cases_reads_back_as_written() {
    // A stride that shares no factor with the container count reaches each.
    let reached: std::collections::BTreeSet<String> = generated::cases()
        .into_iter()
        .step_by(37)
        .map(|case| case.id.rsplit('/').next().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(reached.len(), 10, "{reached:?}");
    within_ceilings(
        "sample",
        &results(generated::cases().into_iter().step_by(37)),
    );
}

/// A CommonMark renderer's reading of a note: its events, with text runs
/// joined and the white space a renderer drops at a block's edge trimmed.
fn rendering(source: &str) -> Vec<String> {
    use pulldown_cmark::{Event, Options, Parser, Tag};
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let mut out: Vec<String> = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<String>| {
        let joined = text.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
        if !joined.is_empty() {
            out.push(format!("text {joined:?}"));
        }
        text.clear();
    };
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Text(value) => text.push_str(&value),
            Event::SoftBreak => text.push(' '),
            other => {
                flush(&mut text, &mut out);
                out.push(match other {
                    Event::Start(Tag::Link {
                        dest_url, title, ..
                    }) => format!("link {dest_url:?} {title:?}"),
                    Event::Start(Tag::Image {
                        dest_url, title, ..
                    }) => format!("image {dest_url:?} {title:?}"),
                    Event::Start(Tag::List(start)) => format!("list {}", start.is_some()),
                    Event::Start(Tag::Item) => "item".to_owned(),
                    other => format!("{other:?}"),
                });
            }
        }
    }
    flush(&mut text, &mut out);
    out
}

/// Another check a finding needs, given the first reading's body and the
/// first write.
type Also = (&'static str, fn(&Value, &str) -> bool);

struct Named {
    id: &'static str,
    source: String,
    also: Option<Also>,
}

fn named_cases() -> Vec<Named> {
    let nbsp = '\u{a0}';
    let plain = |id, source: &str| Named {
        id,
        source: source.to_owned(),
        also: None,
    };
    vec![
        plain("R6-2a indented paragraph", " *qa [[Qn]]*\n"),
        plain("R6-2b indented item paragraph", "- a\n\n   *qb [[Qn]]*\n"),
        plain(
            "R6-1a NBSP line in a quote",
            &format!("> *qa [[Qn]]*\n> {nbsp}\n> qb\n"),
        ),
        plain(
            "R6-1b NBSP line in a marked formula",
            &format!("> **$$qa\n> {nbsp}\n> qb$$**\n"),
        ),
        plain(
            "R1 cell code with edge spaces",
            "| h |\n|---|\n| `  a  ` |\n",
        ),
        plain(
            "R2a reference link after a marked formula",
            "**$$x$$** [label][ref]\n\n[ref]: /target\n",
        ),
        plain(
            "R2b reference link after marked math",
            "**$x$** [label][ref]\n\n[ref]: /target\n",
        ),
        Named {
            id: "R3 wikilink holding a mark",
            source: "[[A *B*]]\n".to_owned(),
            also: Some(("writes [[A *B*]] as written", |_, written| {
                written.contains("[[A *B*]]") && !written.contains("\\[[")
            })),
        },
        Named {
            id: "R6-4 sentence with a path in bold",
            source: "Edit **~/.bashrc** before you run [[Setup]] and see https://x.co.\n"
                .to_owned(),
            also: Some(("reads a live wikilink", |body, _| {
                body.to_string().contains("\"wikilink\"")
            })),
        },
        plain("R6-6 tag span in a heading formula", "# $$<x>$qx$</x>$$\n"),
        plain("R6-5a escaped # after a line", "qa\n\\# qb\n"),
        plain(
            "R6-5b escaped # after a line in a quote",
            "> qa\n> \\# qb\n",
        ),
        plain("R6-5c escaped # after a line in a list", "- qa\n  \\# qb\n"),
    ]
}

/// The sixth review round's findings, each checked as the generated cases
/// are, and against a CommonMark renderer's reading of the source.
#[test]
#[ignore = "a report of the sixth round's findings"]
fn sixth_round_findings_report() {
    let mut lines = Vec::new();
    for case in named_cases() {
        let mut fails = Vec::new();
        let Some((first, w1)) = generated::read(&case.source) else {
            lines.push(format!("{}: FAIL read-error", case.id));
            continue;
        };
        let (second, w2) = generated::read(&w1).expect("reread");
        if second != first {
            fails.push("doc-changes".to_owned());
        }
        if w2 != w1 {
            fails.push("second-save-changes".to_owned());
        }
        let mut written = w2.clone();
        for _ in 0..3 {
            let next = generated::read(&written).expect("reread").1;
            if next != written {
                fails.push("keeps-changing".to_owned());
                break;
            }
            written = next;
        }
        if rendering(&w1) != rendering(&case.source) {
            fails.push("renders-differently".to_owned());
        }
        if let Some((name, check)) = case.also {
            if !check(&first, &w1) {
                fails.push(format!("not: {name}"));
            }
        }
        let verdict = if fails.is_empty() {
            "pass".to_owned()
        } else {
            format!("FAIL {}", fails.join(","))
        };
        lines.push(format!("{}: {verdict} | write1 {w1:?}", case.id));
    }
    // R6-5: an escaped `#` after a line reads alike in each container.
    let readings: Vec<_> = ["qa\n\\# qb\n", "> qa\n> \\# qb\n", "- qa\n  \\# qb\n"]
        .iter()
        .map(|source| generated::flat(&generated::read(source).expect("read").0, 0))
        .collect();
    let alike = readings.windows(2).all(|pair| pair[0] == pair[1]);
    lines.push(format!(
        "R6-5 same reading in paragraph, quote and list: {}",
        if alike { "pass" } else { "FAIL" }
    ));
    // R6-3: a line of escapes, 80 KB.
    let escapes = "\\*".repeat(40_000) + "\n";
    let started = std::time::Instant::now();
    generated::read(&escapes).expect("read");
    lines.push(format!(
        "R6-3 80 KB line of escapes, read and write: {} ms",
        started.elapsed().as_millis()
    ));
    let report = lines.join("\n");
    println!("{report}");
    if let Ok(out) = std::env::var("DOHC_MARKDOWN_NAMED_OUT") {
        std::fs::write(out, report).unwrap();
    }
}

/// Every generated case, held to the full run's ceilings. With
/// `DOHC_MARKDOWN_JUDGE_OUT` set, also writes each case's result as a line of
/// JSON there, to compare with another build's report.
#[test]
#[ignore = "the full run takes minutes"]
fn every_generated_case_report() {
    let results = results(generated::cases().into_iter());
    if let Ok(out) = std::env::var("DOHC_MARKDOWN_JUDGE_OUT") {
        let lines: Vec<_> = results
            .iter()
            .map(|(case, fails, info)| {
                serde_json::json!({ "id": case.id, "source": case.source, "fails": fails, "info": info })
                    .to_string()
            })
            .collect();
        std::fs::write(out, lines.join("\n")).unwrap();
    }
    within_ceilings("full", &results);
}
