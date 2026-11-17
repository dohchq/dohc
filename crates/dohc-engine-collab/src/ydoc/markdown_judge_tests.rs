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
        // Text pulldown-cmark drops: a cell past the header's count, which
        // the cell container makes, and a definition's repeat.
        ("pipe", "qa | qb", "qw\nqa | qb"),
        ("definition", "[qd]: /qe", "[qd]: /qe\n[qd]: /qf"),
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
                // Join runs of one text only; text in two blocks stays apart.
                let first = out.len();
                for item in node["delta"].as_array().into_iter().flatten() {
                    let joins = out.len() > first;
                    if let Some(Value::Object(last)) = out.last_mut().filter(|_| joins) {
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

    /// The reader's words that the cases write: each starts with `q`, so the
    /// syntax around them, such as a node's name, does not count.
    fn tokens(text: &str) -> Vec<String> {
        read_markdown::words(text)
            .filter(|word| word.starts_with(['q', 'Q']))
            .map(str::to_owned)
            .collect()
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
        // Text in two blocks stays two leaves, so skipping the first block
        // leaves the second whole.
        let (nested, _) = read("- qr\n  - qa_qb\n").expect("read");
        let (alone, _) = read("qa_qb\n").expect("read");
        assert_eq!(flat(&nested, 1), flat(&alone, 0));
    }

    fn keeps(found: &[String], wanted: &[String]) -> bool {
        read_markdown::holds_words(found.iter().map(String::as_str), wanted.iter().map(String::as_str))
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

    /// Random mutations of real and example notes, each read, written and
    /// read again with the judge's own word check: shapes nobody listed.
    mod mutation {
        use super::*;
        use std::collections::BTreeMap;
        use std::io::Write as _;
        use std::sync::{Arc, Mutex};
        use std::path::Path;
        use std::time::{Duration, Instant};

        /// splitmix64: a seeded stream, so a run repeats from its seed.
        struct Rng(u64);

        impl Rng {
            fn next(&mut self) -> u64 {
                self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = self.0;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^ (z >> 31)
            }

            fn below(&mut self, n: usize) -> usize {
                (self.next() % n.max(1) as u64) as usize
            }
        }

        /// Each word of two characters or more gets a `q` in front, so the
        /// judge's word check counts it. An entity's name, an address's
        /// scheme, `www` and `atom` stay, so their syntax still reads.
        pub(super) fn quote_words(source: &str) -> String {
            let bytes = source.as_bytes();
            let mut out = String::with_capacity(source.len() * 5 / 4);
            let mut at = 0;
            while at < bytes.len() {
                let starts = bytes[at].is_ascii_alphabetic()
                    && (at == 0 || !bytes[at - 1].is_ascii_alphanumeric());
                if starts {
                    let end = (at..bytes.len())
                        .find(|&i| !bytes[i].is_ascii_alphanumeric())
                        .unwrap_or(bytes.len());
                    let word = &source[at..end];
                    let lower = word.to_ascii_lowercase();
                    let entity = source[..at].ends_with('&') || source[..at].ends_with("&#");
                    let kept = matches!(
                        lower.as_str(),
                        "http" | "https" | "mailto" | "ftp" | "www" | "atom"
                    );
                    if word.len() >= 2 && !entity && !kept {
                        out.push('q');
                    }
                    out.push_str(word);
                    at = end;
                } else {
                    let character = source[at..].chars().next().expect("a character");
                    out.push(character);
                    at += character.len_utf8();
                }
            }
            out
        }

        const SPECIAL: &[&str] = &[
            "[", "]", "(", ")", "*", "_", "~", "$", "=", "<", ">", "\\", "`", "|", "!", "{",
            "}", "#", "-", "+", ":", "&", ";", "\"", "'", "\n", " ", "[[", "]]", "{{atom:",
            "&#35;", "|---|", "> ", "- ", "1. ", "    ", "==", "$$", "```", "\n\n",
        ];

        const PREFIXES: &[&str] = &[
            " ", "  ", "   ", "    ", "\t", "> ", "- ", "1. ", "- [ ] ", "> [!note]\n> ", "| ",
        ];

        fn boundary(text: &str, rng: &mut Rng) -> usize {
            let mut at = rng.below(text.len() + 1);
            while !text.is_char_boundary(at) {
                at -= 1;
            }
            at
        }

        /// One random change: a line duplicated, deleted, swapped, indented,
        /// broken or joined; lines spliced from another seed; a block
        /// repeated; a special character inserted or one doubled.
        fn mutate(source: &str, seeds: &[String], rng: &mut Rng) -> String {
            let mut lines: Vec<String> = source.split_inclusive('\n').map(str::to_owned).collect();
            if lines.is_empty() {
                lines.push(String::new());
            }
            let n = lines.len();
            match rng.below(11) {
                0 => {
                    let line = lines[rng.below(n)].clone();
                    lines.insert(rng.below(n + 1), line);
                }
                1 if n > 1 => {
                    lines.remove(rng.below(n));
                }
                2 => {
                    let (i, j) = (rng.below(n), rng.below(n));
                    lines.swap(i, j);
                }
                3 => {
                    let other: Vec<&str> =
                        seeds[rng.below(seeds.len())].split_inclusive('\n').collect();
                    if !other.is_empty() {
                        let i = rng.below(other.len());
                        let j = (i + 1 + rng.below(4)).min(other.len());
                        let at = rng.below(n + 1);
                        for (k, line) in other[i..j].iter().enumerate() {
                            lines.insert(at + k, (*line).to_owned());
                        }
                    }
                }
                4 => {
                    let i = rng.below(n);
                    let j = (i + 1 + rng.below(3)).min(n);
                    let block = lines[i..j].concat();
                    lines[j - 1].push_str(&block.repeat(1 + rng.below(7)));
                }
                5 => {
                    let i = rng.below(n);
                    lines[i].insert_str(0, PREFIXES[rng.below(PREFIXES.len())]);
                }
                6 => {
                    let i = rng.below(n);
                    let at = boundary(&lines[i], rng);
                    lines[i].insert(at, '\n');
                }
                7 | 8 => {
                    let i = rng.below(n);
                    let at = boundary(&lines[i], rng);
                    lines[i].insert_str(at, SPECIAL[rng.below(SPECIAL.len())]);
                }
                9 => {
                    let i = rng.below(n);
                    let at = boundary(&lines[i], rng);
                    if let Some(character) = lines[i][at..].chars().next() {
                        lines[i].insert(at, character);
                    }
                }
                _ => {
                    let i = rng.below(n.saturating_sub(1));
                    if n > 1 && lines[i].ends_with('\n') {
                        lines[i].pop();
                    }
                }
            }
            lines.concat()
        }

        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
        pub(super) enum Kind {
            Panic,
            RereadRefused,
            Lost,
            LostAfterSave,
            KeepsChanging,
            Slow,
            #[allow(dead_code)]
            Overflow,
        }

        /// A reading (the whole content, front matter with the body) and its
        /// file; `Err` is a panic, `Ok(None)` a refusal.
        pub(super) fn attempt(source: &str) -> Result<Option<(Value, String)>, ()> {
            let source = source.to_owned();
            std::panic::catch_unwind(move || {
                let doc = Ydoc::wire();
                doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
                    .ok()?;
                Some((doc.canonical_content(), doc.project_richdoc().ok()?))
            })
            .map_err(|_| ())
        }

        /// The source's words that a reading must keep, as the reader's own
        /// check counts them.
        pub(super) fn wanted(source: &str) -> Vec<String> {
            tokens(&read_markdown::wanted_text(source))
        }

        fn in_runs(content: &Value) -> Vec<String> {
            let mut found = String::new();
            strings(content, &mut found);
            tokens(&found)
        }

        /// The judge's harm checks on any source, as `check` makes them. A
        /// refusal holds the file as it is, so it is not a finding.
        pub(super) fn judge(source: &str) -> Option<Kind> {
            let (first, w1) = match attempt(source) {
                Err(()) => return Some(Kind::Panic),
                Ok(None) => return None,
                Ok(Some(read)) => read,
            };
            let (second, w2) = match attempt(&w1) {
                Err(()) => return Some(Kind::Panic),
                Ok(None) => return Some(Kind::RereadRefused),
                Ok(Some(read)) => read,
            };
            let mut written = w2;
            for _ in 0..3 {
                match attempt(&written) {
                    Err(()) => return Some(Kind::Panic),
                    Ok(Some((_, next))) if next == written => written = next,
                    _ => return Some(Kind::KeepsChanging),
                }
            }
            let words = in_runs(&first);
            if !keeps(&words, &wanted(source)) {
                return Some(Kind::Lost);
            }
            let (before, after) = (Shown::of(&first["body"]), Shown::of(&second["body"]));
            if !keeps(&in_runs(&second), &words)
                || !keeps(&after.words(), &before.words())
                || before
                    .code
                    .iter()
                    .any(|run| !after.text.contains(run.as_str()))
            {
                return Some(Kind::LostAfterSave);
            }
            None
        }

        fn read_time(source: &str) -> Duration {
            (0..2)
                .map(|_| {
                    let doc = Ydoc::wire();
                    let started = Instant::now();
                    let _ = doc.rewrite_content_to_markdown(ContentKind::Richdoc, source);
                    started.elapsed()
                })
                .min()
                .expect("a time")
        }

        /// A source with `unit` repeated `times` between `before` and `after`.
        #[derive(Clone)]
        struct Scaled {
            before: String,
            unit: String,
            after: String,
        }

        impl Scaled {
            fn at(&self, times: usize) -> String {
                format!("{}{}{}", self.before, self.unit.repeat(times), self.after)
            }

            /// Four times the repeats taking more than eight times as long,
            /// twice over: time that grows faster than the length.
            fn slow(&self, times: usize, current: &Path) -> bool {
                let check = || {
                    let small = self.at(times);
                    let big = self.at(times * 4);
                    let _ = std::fs::write(current, &big);
                    let (t1, t4) = (read_time(&small), read_time(&big));
                    t4 > t1 * 8 && t4 > Duration::from_millis(25)
                };
                check() && check()
            }
        }

        /// Repeats that make the smaller copy about 8 KiB.
        fn times_for(unit: &str) -> usize {
            (8192 / unit.len().max(1)).clamp(2, 4096)
        }

        fn scaled(source: &str, rng: &mut Rng) -> Option<Scaled> {
            let lines: Vec<&str> = source.split_inclusive('\n').collect();
            if lines.is_empty() {
                return None;
            }
            let mode = rng.below(4);
            if mode == 0 {
                // The whole note, repeated.
                return Some(Scaled {
                    before: String::new(),
                    unit: source.to_owned(),
                    after: String::new(),
                });
            }
            if mode == 1 {
                // One block between blank lines, such as a whole table,
                // repeated with no blank line between the copies.
                let blank = |line: &str| line.trim().is_empty();
                let starts: Vec<usize> = (0..lines.len())
                    .filter(|&i| !blank(lines[i]) && (i == 0 || blank(lines[i - 1])))
                    .collect();
                let i = *starts.get(rng.below(starts.len()))?;
                let j = (i..lines.len()).find(|&j| blank(lines[j])).unwrap_or(lines.len());
                let mut unit = lines[i..j].concat();
                if !unit.ends_with('\n') {
                    unit.push('\n');
                }
                return Some(Scaled {
                    before: lines[..i].concat(),
                    unit,
                    after: lines[j..].concat(),
                });
            }
            if mode == 2 {
                let i = rng.below(lines.len());
                let j = (i + 1 + rng.below(3)).min(lines.len());
                Some(Scaled {
                    before: lines[..i].concat(),
                    unit: lines[i..j].concat(),
                    after: lines[j..].concat(),
                })
            } else {
                let start = boundary(source, rng);
                let mut end = (start + 1 + rng.below(8)).min(source.len());
                while !source.is_char_boundary(end) {
                    end += 1;
                }
                (end > start).then(|| Scaled {
                    before: source[..start].to_owned(),
                    unit: source[start..end].to_owned(),
                    after: source[end..].to_owned(),
                })
            }
        }

        /// Smaller and smaller inputs that still fail: lines, then
        /// characters, removed while `fails` holds, within `budget` tries.
        fn shrink(mut text: String, budget: usize, fails: &mut dyn FnMut(&str) -> bool) -> String {
            let mut tries = 0;
            for by_lines in [true, false] {
                let mut chunk = 8;
                while chunk >= 1 && tries < budget {
                    let pieces: Vec<String> = if by_lines {
                        text.split_inclusive('\n').map(str::to_owned).collect()
                    } else {
                        text.chars().map(String::from).collect()
                    };
                    let mut removed = false;
                    let mut at = 0;
                    let mut kept = pieces.clone();
                    while at < kept.len() && tries < budget {
                        let end = (at + chunk).min(kept.len());
                        let candidate: String = kept[..at].concat() + &kept[end..].concat();
                        tries += 1;
                        if candidate.len() < text.len() && fails(&candidate) {
                            kept.drain(at..end);
                            text = candidate;
                            removed = true;
                        } else {
                            at += chunk;
                        }
                    }
                    if !removed {
                        chunk /= 2;
                    }
                }
            }
            text
        }

        /// A finding's shape: its words as `q`, so findings that differ only
        /// in words group.
        fn shape(source: &str) -> String {
            let mut out = String::new();
            let mut word = false;
            for character in source.chars() {
                if character.is_ascii_alphanumeric() {
                    if !word {
                        out.push('w');
                    }
                    word = true;
                } else {
                    out.push(character);
                    word = false;
                }
            }
            out
        }

        struct Found {
            kind: Kind,
            shape: String,
            example: String,
            unit: Option<(String, usize)>,
            seed: String,
            count: usize,
        }

        /// What the judge saw for each source in `DOHC_MUTATION_EXPLAIN` (a
        /// JSON list of strings; `a<<b>>c` times `b` repeated), one JSON
        /// line each.
        /// The file at DOHC_PROBE_FILE read, written and read again on a
        /// 2 MiB stack, as the mutation threads have, naming each step as it
        /// starts, so a stack overflow shows where it happened.
        #[test]
        #[ignore = "probes one file"]
        fn mutation_probe() {
            let path = std::env::var("DOHC_PROBE_FILE").expect("DOHC_PROBE_FILE");
            let source = std::fs::read_to_string(path).expect("the probe file");
            std::thread::Builder::new()
                .stack_size(2 << 20)
                .spawn(move || {
                    let step = |name: &str| eprintln!("step {name}");
                    step("read");
                    let doc = Ydoc::wire();
                    let read = doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source);
                    step(if read.is_ok() { "write" } else { "refused" });
                    let Ok(written) = doc.project_richdoc() else {
                        step("write-refused");
                        return;
                    };
                    step("reread");
                    let again = Ydoc::wire();
                    let read = again.rewrite_content_to_markdown(ContentKind::Richdoc, &written);
                    step(if read.is_ok() { "rewrite" } else { "reread-refused" });
                    let _ = again.project_richdoc();
                    let sealed = doc.canonical_content().to_string().contains("rawBlock");
                    step(&format!("done sealed={sealed}"));
                })
                .expect("a thread")
                .join()
                .expect("the probe");
        }

        #[test]
        #[ignore = "explains given findings"]
        fn mutation_explain() {
            std::panic::set_hook(Box::new(|_| {}));
            let path = std::env::var("DOHC_MUTATION_EXPLAIN").expect("DOHC_MUTATION_EXPLAIN");
            let sources: Vec<String> =
                serde_json::from_str(&std::fs::read_to_string(path).expect("list")).expect("json");
            for source in sources {
                if let (Some(open), Some(close)) = (source.find("<<"), source.rfind(">>")) {
                    if open + 2 <= close {
                        let scaled = Scaled {
                            before: source[..open].to_owned(),
                            unit: source[open + 2..close].to_owned(),
                            after: source[close + 2..].to_owned(),
                        };
                        let times = times_for(&scaled.unit);
                        let ms: Vec<f64> = [1, 4, 16]
                            .iter()
                            .map(|k| read_time(&scaled.at(times * k)).as_secs_f64() * 1000.0)
                            .collect();
                        println!("{}", serde_json::json!({"source": source, "times": times, "ms": ms}));
                        continue;
                    }
                }
                let kind = judge(&source).map(|kind| format!("{kind:?}"));
                let first = attempt(&source).ok().flatten();
                let w1 = first.as_ref().map(|read| read.1.clone()).unwrap_or_default();
                let second = attempt(&w1).ok().flatten();
                let w2 = second.as_ref().map(|read| read.1.clone()).unwrap_or_default();
                let w3 = attempt(&w2).ok().flatten().map(|read| read.1).unwrap_or_default();
                let missing = |found: &[String], wanted: &[String]| {
                    let mut left: HashMap<&str, usize> = HashMap::new();
                    for word in found {
                        *left.entry(word.as_str()).or_default() += 1;
                    }
                    wanted
                        .iter()
                        .filter(|word| match left.get_mut(word.as_str()) {
                            Some(count) if *count > 0 => {
                                *count -= 1;
                                false
                            }
                            _ => true,
                        })
                        .cloned()
                        .collect::<Vec<_>>()
                };
                let lost = first
                    .as_ref()
                    .map(|read| missing(&in_runs(&read.0), &wanted(&source)));
                let lost_after = first.as_ref().zip(second.as_ref()).map(|(one, two)| {
                    missing(&in_runs(&two.0), &in_runs(&one.0))
                });
                println!(
                    "{}",
                    serde_json::json!({
                        "source": source, "kind": kind, "lost": lost, "lost_after_save": lost_after,
                        "body": first.as_ref().map(|read| &read.0["body"]),
                        "w1": w1, "w2": w2, "w3": w3,
                    })
                );
            }
        }

        /// The mutation run: `DOHC_MUTATION_SEEDS` (a JSON list of
        /// `{id, source}`), `DOHC_MUTATION_OUT` (a folder), and
        /// `DOHC_MUTATION_SECONDS`, `DOHC_MUTATION_SEED`,
        /// `DOHC_MUTATION_THREADS`. Before each read a thread writes its
        /// input to `current-<thread>.md`, so a stack overflow, which ends
        /// the process, leaves its input behind.
        #[test]
        #[ignore = "a timed random run"]
        fn mutation_run() {
            let env = |name: &str| std::env::var(name).ok();
            let seeds_path = env("DOHC_MUTATION_SEEDS").expect("DOHC_MUTATION_SEEDS");
            let out = std::path::PathBuf::from(env("DOHC_MUTATION_OUT").expect("DOHC_MUTATION_OUT"));
            let seconds: u64 = env("DOHC_MUTATION_SECONDS").map_or(60, |s| s.parse().expect("seconds"));
            let base: u64 = env("DOHC_MUTATION_SEED").map_or(1, |s| s.parse().expect("seed"));
            let threads: usize = env("DOHC_MUTATION_THREADS").map_or(4, |s| s.parse().expect("threads"));
            std::fs::create_dir_all(&out).expect("out folder");
            // A panic is a finding, counted; its message is noise here.
            std::panic::set_hook(Box::new(|_| {}));
            let mut seeds: Vec<(String, String)> =
                serde_json::from_str::<Vec<Value>>(&std::fs::read_to_string(seeds_path).expect("seeds"))
                    .expect("seeds json")
                    .into_iter()
                    .map(|seed| {
                        (
                            seed["id"].as_str().unwrap_or_default().to_owned(),
                            quote_words(seed["source"].as_str().unwrap_or_default()),
                        )
                    })
                    .collect();
            // The named cases, without this round's two: the run must find
            // those by itself.
            seeds.extend(
                super::super::named_cases()
                    .into_iter()
                    .filter(|named| !named.id.starts_with("R8-"))
                    .map(|named| (named.id.to_owned(), named.source)),
            );
            let sources: Arc<Vec<String>> = Arc::new(seeds.iter().map(|seed| seed.1.clone()).collect());
            let seeds = Arc::new(seeds);
            let found: Arc<Mutex<BTreeMap<(Kind, String), Found>>> = Arc::default();
            let log = Arc::new(Mutex::new(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(out.join("findings.jsonl"))
                    .expect("findings file"),
            ));
            let judged = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let deadline = Instant::now() + Duration::from_secs(seconds);
            let workers: Vec<_> = (0..threads)
                .map(|thread| {
                    let (seeds, sources, found, log, judged, out) = (
                        seeds.clone(),
                        sources.clone(),
                        found.clone(),
                        log.clone(),
                        judged.clone(),
                        out.clone(),
                    );
                    std::thread::Builder::new()
                        .name(format!("mutation-{thread}"))
                        .stack_size(2 << 20)
                        .spawn(move || {
                            let mut rng = Rng(base.wrapping_mul(1_000_003).wrapping_add(thread as u64));
                            let current = out.join(format!("current-{thread}.md"));
                            let mut noted = Instant::now();
                            while Instant::now() < deadline {
                                if thread == 0 && noted.elapsed() > Duration::from_secs(5) {
                                    noted = Instant::now();
                                    let count = judged.load(std::sync::atomic::Ordering::Relaxed);
                                    let _ = std::fs::write(out.join(format!("judged-{base}.txt")), count.to_string());
                                }
                                let (id, seed) = &seeds[rng.below(seeds.len())];
                                let mut source = seed.clone();
                                for _ in 0..1 + rng.below(4) {
                                    source = mutate(&source, &sources, &mut rng);
                                }
                                if source.len() > 64 * 1024 {
                                    continue;
                                }
                                judged.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let _ = std::fs::write(&current, &source);
                                let report = |kind: Kind, example: String, unit: Option<(String, usize)>| {
                                    let key = (kind, shape(&example));
                                    let mut found = found.lock().expect("found");
                                    if let Some(old) = found.get_mut(&key) {
                                        old.count += 1;
                                        return;
                                    }
                                    let line = serde_json::json!({
                                        "kind": format!("{kind:?}"), "shape": key.1, "example": example,
                                        "unit": unit.as_ref().map(|u| &u.0), "times": unit.as_ref().map(|u| u.1),
                                        "seed": id,
                                    });
                                    let _ = writeln!(log.lock().expect("log"), "{line}");
                                    found.insert(
                                        key.clone(),
                                        Found { kind, shape: key.1, example, unit, seed: id.clone(), count: 1 },
                                    );
                                };
                                if let Some(kind) = judge(&source) {
                                    let example = shrink(source, 200, &mut |candidate| {
                                        let _ = std::fs::write(&current, candidate);
                                        judge(candidate) == Some(kind)
                                    });
                                    report(kind, example, None);
                                    continue;
                                }
                                if rng.below(8) != 0 {
                                    continue;
                                }
                                let Some(scaled) = scaled(&source, &mut rng) else {
                                    continue;
                                };
                                let times = times_for(&scaled.unit);
                                // Keep the larger copy near 512 KiB or under.
                                if scaled.at(times * 4).len() > 512 * 1024 {
                                    continue;
                                }
                                if scaled.slow(times, &current) {
                                    let mut small = scaled.clone();
                                    small.unit = shrink(scaled.unit.clone(), 30, &mut |unit| {
                                        !unit.is_empty()
                                            && Scaled { unit: unit.to_owned(), ..scaled.clone() }
                                                .slow(times_for(unit), &current)
                                    });
                                    small.before = shrink(small.before.clone(), 20, &mut |before| {
                                        Scaled { before: before.to_owned(), ..small.clone() }
                                            .slow(times_for(&small.unit), &current)
                                    });
                                    small.after = shrink(small.after.clone(), 20, &mut |after| {
                                        Scaled { after: after.to_owned(), ..small.clone() }
                                            .slow(times_for(&small.unit), &current)
                                    });
                                    let example = format!("{}<<{}>>{}", small.before, small.unit, small.after);
                                    let times = times_for(&small.unit);
                                    report(Kind::Slow, example, Some((small.unit, times)));
                                }
                            }
                        })
                        .expect("a worker")
                })
                .collect();
            for worker in workers {
                worker.join().expect("a worker");
            }
            let found = found.lock().expect("found");
            let mut summary = BTreeMap::new();
            for item in found.values() {
                *summary.entry(format!("{:?}", item.kind)).or_insert(0usize) += 1;
            }
            let report = serde_json::json!({
                "seed": base, "seconds": seconds, "threads": threads,
                "judged": judged.load(std::sync::atomic::Ordering::Relaxed),
                "shapes": summary,
                "found": found.values().map(|item| serde_json::json!({
                    "kind": format!("{:?}", item.kind), "shape": item.shape, "example": item.example,
                    "unit": item.unit.as_ref().map(|u| &u.0), "seed": item.seed, "count": item.count,
                })).collect::<Vec<_>>(),
            });
            std::fs::write(out.join(format!("summary-{base}.json")), report.to_string()).expect("summary");
            println!("{}", serde_json::to_string_pretty(&report["shapes"]).expect("shapes"));
        }
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
        plain(
            "R8-1 table row with more cells than its header",
            "| qa | qb |\n|---|---|\n| qc | qd | qhidden |\n",
        ),
        plain(
            "R8-2 repeated reference definitions",
            "Text [qx].\n\n[qx]: /qa\n[qx]: /qb \"qkept\"\n",
        ),
    ]
}

/// Text pulldown-cmark drops or reads as nothing: a cell past the header's
/// count, and each definition of a label after the first.
#[test]
fn a_dropped_cell_or_definition_keeps_its_words() {
    let mut sources: Vec<String> = named_cases()
        .into_iter()
        .filter(|case| case.id.starts_with("R8-"))
        .map(|case| case.source)
        .collect();
    sources.extend(
        [
            "a | b\n--- | ---\nqc | qd\nqe | qf | qhidden\n",
            "> | qa | qb |\n> |---|---|\n> | qc | qd | qhidden |\n",
            "- [ ] qt\n  | qa | qb |\n  |---|---|\n  | qc | qd | qhidden |\n",
            "| qa | qb |\n|---|---|\n| `qc|qx` | qd |\n",
            "| qa | qb |\n|---|---|\n| qc | qd | qe |\n|---|---|---|\n| qf | qg | qh |\n",
            "[qx]: /qa\n[qx]: /qb\n[qx]: /qc\n",
            "- [qx]: /qa\n- [qx]: /qb\n",
            "- [ ] qt\n\n  qm\n- [x] qu\n",
            "- qi\n\n  [qx]: /qa\n  [qx]: /qb\n- qj\n",
            "> [qx]: /qa\n> [qx]: /qb\n",
            "> [!note]\n> [qx]: /qa\n> [qx]: /qb\n",
        ]
        .map(str::to_owned),
    );
    for source in sources {
        let case = generated::Case {
            id: String::new(),
            inline: source.clone(),
            source: source.clone(),
            skip: 0,
            holds_blocks: true,
            indented: false,
        };
        let fails = generated::check(&case, &mut std::collections::HashMap::new());
        let harm: Vec<_> = fails.iter().filter(|check| HARM.contains(check)).collect();
        assert!(harm.is_empty(), "{source:?}: {harm:?}");
    }
    // The editor ends the table at that row and reads the rest as text, and
    // keeps each definition as a paragraph of its own.
    let (body, _) = generated::read("| qa | qb |\n|---|---|\n| qc | qd | qhidden |\n").unwrap();
    let blocks = body["children"].as_array().unwrap();
    assert_eq!(blocks[0]["tag"], "table");
    assert_eq!(blocks[0]["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        generated::flat(&blocks[1], 0),
        [serde_json::json!({"insert": "| qc | qd | qhidden |"})]
    );
    let (body, _) = generated::read("[qx]: /qa\n[qx]: /qb \"qkept\"\n").unwrap();
    let texts: Vec<_> = body["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| generated::flat(block, 0)[0]["insert"].clone())
        .collect();
    assert_eq!(texts, ["[qx]: /qa", "[qx]: /qb \"qkept\""]);
}

/// A link's address and title read as the editor reads them: of the
/// references, only the block escapes its writer uses decode. Each expected
/// value is the editor's reading of the source.
#[test]
fn a_link_reads_references_in_its_address_and_title() {
    for (source, href, title) in [
        ("[qa](/a&#35;b \"t&#33;\")\n", "/a#b", "t&#33;"),
        (
            "[qa][r]\n\n[r]: /a&#35;&ouml; \"t&#33;&#35;\"\n",
            "/a#&ouml;",
            "t&#33;#",
        ),
        ("[qa](<a&#35;b c>)\n", "a#b c", ""),
        (
            "[qa](/f&ouml; \"title \\\"&quot;\")\n",
            "/f&ouml;",
            "title \"&quot;",
        ),
        (
            "[qa](/a&#33;b \"t&#35;&amp;#35;&#160;&#38;x\")\n",
            "/a&#33;b",
            "t#&#35;\u{a0}&#38;x",
        ),
        (
            "[qa](/a\\&#35;b \"&#035;&#x23;\")\n",
            "/a&#35;b",
            "&#035;&#x23;",
        ),
        (
            "[qa](/a&amp;b \"&#91;&#93;&#96;\")\n",
            "/a&amp;b",
            "[&#93;`",
        ),
    ] {
        let (body, _) = generated::read(source).unwrap();
        let link = &generated::flat(&body, 0)[0]["attrs"]["link"];
        assert_eq!(link["href"], href, "{source:?}");
        assert_eq!(link["title"].as_str().unwrap_or(""), title, "{source:?}");
    }
}

/// A long line of one character, or of it as an opener nothing closes, reads
/// in time that grows no faster than its length.
#[test]
fn a_long_line_of_one_character_reads_in_linear_time() {
    let time = |line: &str| {
        (0..3)
            .map(|_| {
                let doc = Ydoc::wire();
                let started = std::time::Instant::now();
                doc.rewrite_content_to_markdown(ContentKind::Richdoc, line)
                    .unwrap();
                started.elapsed()
            })
            .min()
            .unwrap()
    };
    let mut slow = Vec::new();
    let mut lines = Vec::new();
    for character in [
        "[", "]", "*", "_", "~", "$", "=", "<", "\\", "`", "|", "!", "{",
    ] {
        lines.push((character, "alone", "", character.to_owned()));
        lines.push((character, "opener", "", format!("{character}a ")));
    }
    // An address's trailing `)` and `&name;` are trimmed one at a time, and
    // an atom nothing closes is scanned from each opening.
    lines.push((")", "after an address", "https://qe.com/", ")".to_owned()));
    lines.push((
        "&a;",
        "after an address",
        "https://qe.com/",
        "&a;".to_owned(),
    ));
    lines.push(("{{atom:", "alone", "", "{{atom:".to_owned()));
    for (character, name, start, unit) in lines {
        let line = |bytes: usize| format!("{start}{}\n", unit.repeat(bytes / unit.len()));
        let (half, full) = (time(&line(32 * 1024)), time(&line(64 * 1024)));
        // Twice the length takes about twice the time; a square would take
        // four times.
        if full > half * 3 && full > std::time::Duration::from_millis(20) {
            slow.push(format!("{character:?} {name}: {half:?} then {full:?}"));
        }
    }
    assert!(slow.is_empty(), "{slow:#?}");
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
