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
    ];

    pub(super) struct Case {
        pub id: String,
        pub inline: String,
        pub source: String,
        pub skip: usize,
        /// Whether the container can hold a block, such as a math block.
        /// A heading or a cell holds one line of text and no blocks.
        pub holds_blocks: bool,
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
                            });
                        }
                    }
                }
            }
        }
        cases
    }

    fn read(source: &str) -> Option<(Value, String)> {
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

    fn flat(body: &Value, skip: usize) -> Vec<Value> {
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
        let json = first.to_string();
        if tokens(&case.inline)
            .iter()
            .any(|token| !json.contains(token.as_str()))
        {
            fails.push("text-lost");
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
            if block && !case.holds_blocks {
                fails.push("info:holds-no-block");
            } else if flat(&first, case.skip) != reference {
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

/// Every 40th generated case fails only as listed. Each listed case also
/// fails on main, where the editor's reader keeps such a note as text, so
/// none is a regression. A case that starts to pass leaves the list.
#[test]
fn a_sample_of_generated_cases_reads_back_as_written() {
    let known: std::collections::BTreeSet<&str> = include_str!("markdown_judge_known.txt")
        .lines()
        .filter(|line| !line.is_empty())
        .collect();
    let mut failing = std::collections::BTreeSet::new();
    for (case, fails, _) in results(generated::cases().into_iter().step_by(40)) {
        if !fails.is_empty() {
            failing.insert(format!("{} {}", case.id, fails.join(",")));
        }
    }
    let new: Vec<_> = failing
        .iter()
        .filter(|line| !known.contains(line.as_str()))
        .collect();
    let passing: Vec<_> = known
        .iter()
        .filter(|line| !failing.contains(**line))
        .collect();
    assert!(
        new.is_empty() && passing.is_empty(),
        "new failures {new:#?}\nnow passing {passing:#?}"
    );
}

/// Writes each case's result as a line of JSON to `DOHC_MARKDOWN_JUDGE_OUT`,
/// to compare with another build's report.
#[test]
#[ignore = "the full run takes minutes"]
fn every_generated_case_report() {
    let out = std::env::var("DOHC_MARKDOWN_JUDGE_OUT").expect("DOHC_MARKDOWN_JUDGE_OUT");
    let lines: Vec<_> = results(generated::cases().into_iter())
        .into_iter()
        .map(|(case, fails, info)| {
            serde_json::json!({ "id": case.id, "source": case.source, "fails": fails, "info": info })
                .to_string()
        })
        .collect();
    std::fs::write(out, lines.join("\n")).unwrap();
}
