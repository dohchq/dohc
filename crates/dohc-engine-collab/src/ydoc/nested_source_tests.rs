use super::*;

fn successor(source: &str) -> Result<SuccessorBase, CollabError> {
    let key = crate::DocKey::new("workspace", "main", "object").unwrap();
    fresh_successor_base(
        &SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: "claim",
            predecessor_state_vector_sha256: "vector",
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: "preimage",
            content_kind: ContentKind::Richdoc,
            result_sha256: &crate::hex_sha256(source.as_bytes()),
        }),
        source,
    )
}

#[test]
fn a_successor_keeps_indented_code_and_refuses_quote_overflow() {
    for source in ["Text\n\n    code\n", "Install:\n\n    npm i foo"] {
        assert!(successor(source).is_ok(), "{source:?}");
    }
    assert!(successor(&format!("{}deep", "> ".repeat(121))).is_err());
}

/// A formula in an item or a quote reads without the indentation and quote
/// markers its container puts on each line, as the editor reads it, so it
/// is written back as it was rather than indented again.
#[test]
fn a_formula_in_a_container_reads_without_the_container_prefix() {
    for source in ["- step\n\n  $$\n  x^2\n  $$\n", "> $$\n> x^2\n> $$\n"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        let body = doc.canonical_content()["body"].to_string();
        assert!(body.contains(r#""tex":"\nx^2\n""#), "{source:?}: {body}");
        assert_eq!(doc.project_richdoc().unwrap(), source);
    }
}

/// A formula in a link, a mark or an image's alt stays text, so the link,
/// the mark and the formula are all kept. The editor's reader drops the
/// formula from an alt and a link from a formula on its own line.
#[test]
fn a_formula_in_a_link_a_mark_or_an_alt_keeps_its_text() {
    let mut failures = Vec::new();
    for (source, kept) in [
        ("[$$x$$](u)\n", [r#""insert":"$$x$$""#, r#""href":"u""#]),
        ("**$$x$$**\n", [r#""insert":"$$x$$""#, r#""bold""#]),
        ("![$$x$$](u)\n", [r#""alt":"$$x$$""#, r#""src":"u""#]),
        ("==$$x$$==\n", [r#""insert":"$$x$$""#, r#""highlight""#]),
        ("++$$x$$++\n", [r#""insert":"$$x$$""#, r#""underline""#]),
        ("# ==$$x$$==\n", [r#""insert":"$$x$$""#, r#""highlight""#]),
        // A formula over lines keeps none of its containers' markers.
        (
            "> ==$$a\n> b$$==\n",
            [r#""insert":"$$a\nb$$""#, r#""highlight""#],
        ),
        (
            "- **$$a\n  b$$**\n",
            [r#""insert":"$$a\nb$$""#, r#""bold""#],
        ),
        (
            "> a $$x\n> y$$ b\n",
            [r#""insert":"a $$x\ny$$ b""#, r#""tag":"blockquote""#],
        ),
        (
            "> a $$x\n> y$$\n> ---\n",
            [r#""insert":"a $$x\ny$$""#, r#""heading""#],
        ),
        (
            "> ![$$a\n> b$$](u)\n",
            [r#""alt":"$$a\nb$$""#, r#""src":"u""#],
        ),
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        let body = doc.canonical_content()["body"].to_string();
        for kept in kept {
            if !body.contains(kept) {
                failures.push(format!("{source:?}: {kept} in {body}"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The writer escapes `=` in a highlight, so a formula there reads back
/// as the same text however often it is written.
#[test]
fn a_formula_in_a_highlight_reads_back_as_written() {
    for source in ["==$$x=y$$==\n", "# ==$$a==b$$==\n"] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        let first = doc.canonical_content()["body"].to_string();
        for _ in 0..2 {
            let written = doc.project_richdoc().unwrap();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &written)
                .unwrap();
            assert_eq!(
                doc.canonical_content()["body"].to_string(),
                first,
                "{source:?} written as {written:?}"
            );
        }
    }
}

/// A heading, a cell and a callout in a quote read as the editor reads
/// them, and no text they hold is dropped.
#[test]
fn headings_cells_and_nested_callouts_read_as_the_editor_reads_them() {
    let body = |source: &str| {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        (
            doc.canonical_content()["body"].to_string(),
            doc.project_richdoc().unwrap(),
        )
    };
    let failures: Vec<_> = [
        ("# Formula $$x$$\n", r#""insert":"Formula $$x$$""#),
        ("| a |\n|---|\n| $$x$$ |\n", r#""insert":"$$x$$""#),
        ("# ==important== and [[Note]]\n", r#""highlight""#),
        ("# ==important== and [[Note]]\n", r#""tag":"wikilink""#),
        ("==a\\é==\n", r#""highlight""#),
    ]
    .into_iter()
    .filter(|(source, holds)| {
        !std::panic::catch_unwind(|| body(source).0.contains(holds)).unwrap_or(false)
    })
    .collect();
    assert!(failures.is_empty(), "{failures:?}");
    // The callout holds its body once, not inside another quote.
    let source = "> > [!note]\n> > body\n";
    let (body, projection) = body(source);
    assert_eq!(body.matches(r#""tag":"blockquote""#).count(), 1, "{body}");
    assert_eq!(projection, source);
}

/// A callout reads its body again, so a callout inside it must not read
/// its own body too: that doubles the work at each level.
#[test]
fn nested_callouts_read_in_time() {
    let source: String = (1..=22)
        .map(|level| format!("{} [!note]\n", ">".repeat(level)))
        .collect();
    let started = std::time::Instant::now();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
        .unwrap();
    // Each level read once takes milliseconds; reading each level's body
    // at every level above it takes minutes.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn nested_html_tags_read_in_time() {
    let depth = 4096;
    let open: String = (0..depth).map(|i| format!("<t{i}>")).collect();
    let close: String = (0..depth).rev().map(|i| format!("</t{i}>")).collect();
    let source = format!("{open}a{close}\n");
    let started = std::time::Instant::now();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
        .unwrap();
    // Reading each tag's run once takes milliseconds; reading every run
    // inside it again at each tag takes minutes.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn tags_in_a_highlight_read_in_time() {
    // Each tag follows a decoded `<` and holds `\=`, which a highlight reads
    // as `=` only in source.
    let tags: String = (0..16384)
        .map(|i| format!("&lt;<t{i} a=\"\\=\"> a "))
        .collect();
    let source = format!("=={tags}==\n");
    let started = std::time::Instant::now();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
        .unwrap();
    // Telling each tag is source by finding it in the note takes the
    // note's length for each tag.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_frontmatter_fold_repairs_a_missing_schema_version() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "- parent\n  - child\n")
        .unwrap();
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    meta.remove(&mut doc.doc.transact_mut(), "schemaVersion");
    doc.replace_frontmatter_for_fold("---\nstatus: open\n---\n- parent\n  - child\n")
        .unwrap();
    assert_eq!(
        meta.get(&doc.doc.transact(), "schemaVersion"),
        Some(Out::Any(Any::Number(1.0)))
    );
}

#[test]
fn a_canonical_frontmatter_fold_drops_a_redundant_witness() {
    let source = "---\nstatus: open\n---\n- parent\n  - child\n";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    let body = doc.canonical_content()["body"].clone();
    let chosen = source.replace("open", "done");
    doc.replace_frontmatter_for_fold(&chosen).unwrap();
    assert_eq!(doc.project_richdoc().unwrap(), chosen);
    assert_eq!(doc.canonical_content()["body"], body);
    assert!(doc.markdown_source_reference().is_none());
}

fn nested_sources() -> Vec<&'static str> {
    [
        "- a\n  b\n  ===\n  - c\n",
        "- a\n  --\n  - c",
        "- a\n  b\n  --\n  - c",
        "- a\n  -",
        "```\nx\n````\n- a\n  - b\n```\n",
        "- a\n\n- b\n  - c",
        "- p\n  - a\n\n  - b",
        "* parent\n  * a\n\n  * b\n",
        "1. a\n    1. child\n\n2. b\n",
        "- parent\n  - child\n\n| h |\n| --- |\n| v |\n",
        "- step\n\n  $$\n  x^2\n  $$\n  - sub\n",
        "- $$\n  x^2\n  $$\n  - sub\n",
        "- parent\n\n  <div\n  - child",
        "- parent\n\n  <div \n  - child",
        "- parent\n\n  <pre\n  - child",
        "- a\n\n  ```\n  code\n  ````\n  <div>\n  ```\n",
        "- a\n\n  ```\n  code\n   ```\n  <div>\n  ```\n",
        "```bad`info\n```\n- a\n  - child\n  <div>\n```\n",
        "- parent\n  - child\n\n> [link](https://example.com)",
        "- parent\n  - child\n\n> &amp;",
        "- parent\n  - child\n\n<!-- dohc:table row-heights=1:40 -->\n| h |\n| --- |\n| [link](https://example.com) |",
        "- [link](https://example.com) and `code`\n  - child",
        "- ~~strike~~ &amp; \\*literal\\*\n  - child",
    ].into_iter().chain(inline_sources()).collect()
}

fn plain_inline_sources() -> [&'static str; 8] {
    [
        "- plain text\n  - child",
        "- Café 中文 ١٢٣ . , ; : ! ? ' \" ( ) - /\n  - child",
        "- a  \n  - child",
        "- parent\n\n  ```txt\n  [ < > & $ {{atom:example}}\n  ```\n  - child",
        "```txt\n[ < > & $ {{atom:example}}\n```\n\n- parent\n  - child",
        "- parent\n\n  ```c++\n  code\n  ```\n  - child",
        "- parent\n\n  ```c#\n  code\n  ```\n  - child",
        "- parent\n\n  ```lang_1.+#-\n  code\n  ```\n  - child",
    ]
}

fn generated_sources() -> Vec<String> {
    let mut sources = Vec::new();
    for parent in ["-", "*", "+", "1.", "3)", "- [ ]", "* [x]", "+ [X]"] {
        for child in ["-", "*", "+", "1.", "0)", "- [ ]", "* [x]", "+ [X]"] {
            for indent in [2, 4] {
                let width = if parent.as_bytes()[0].is_ascii_digit() {
                    3
                } else {
                    2
                };
                if indent < width {
                    continue;
                }
                for loose in [false, true] {
                    for shape in [0, 1, 2] {
                        let gap = if loose { "\n" } else { "" };
                        let pad = " ".repeat(indent);
                        let continuation = " ".repeat(width);
                        let tail = match shape {
                            0 => String::new(),
                            1 => format!("\n\n{continuation}second paragraph"),
                            _ => format!("\n\n{continuation}```txt\n{continuation}literal code\n{continuation}```"),
                        };
                        let grand = " ".repeat(
                            indent
                                + if child.as_bytes()[0].is_ascii_digit() {
                                    4
                                } else {
                                    2
                                },
                        );
                        let base = format!(
                            "{parent} parent\n{gap}{pad}{child} child\n{grand}- grandchild{tail}"
                        );
                        for crlf in [false, true] {
                            for eof in [false, true] {
                                let source = format!("{base}{}", if eof { "\n" } else { "" });
                                sources.push(if crlf {
                                    source.replace('\n', "\r\n")
                                } else {
                                    source
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    for parent in ["-", "*", "+", "1.", "3)", "- [ ]", "* [x]", "+ [X]"] {
        let width = if parent.as_bytes()[0].is_ascii_digit() {
            4
        } else {
            2
        };
        for level in 0..4 {
            for inline in [
                "plain",
                "plain punctuation!",
                "ordinary continuation",
                "more plain text",
            ] {
                let mut source = String::new();
                for depth in 0..4 {
                    source.push_str(&format!("{}{parent} {inline}\n", " ".repeat(depth * width)));
                }
                let sibling = if parent.starts_with("1.") {
                    parent.replacen("1.", "2.", 1)
                } else if parent.starts_with("3)") {
                    parent.replacen("3)", "4)", 1)
                } else {
                    parent.to_owned()
                };
                source.push_str(&format!("{}{sibling} sibling", " ".repeat(level * width)));
                for surround in [false, true] {
                    sources.push(if surround { format!("---\ntitle: 'quoted'\nstatus: open\n---\n# Before\n\n{source}\n\nAfter\n\n```txt\nliteral\n```\n") } else { source.clone() });
                }
            }
        }
    }
    sources.extend(
        [
            "- parent\n  - child\n  - next\n- sibling",
            "- parent\n\n  ```txt\n  literal\n  ```\n  - child",
            "# Heading\n\n- parent\n  - child\n\n> plain prose\n\n---",
            "- parent\n  - child\n\n<!-- dohc:table row-heights=1:40 -->\n| h |\n| --- |\n| plain |",
        ]
        .map(str::to_owned),
    );
    for (first, next) in [
        ("-", "*"),
        ("*", "+"),
        ("+", "-"),
        ("1.", "2)"),
        ("1)", "2."),
        ("- [ ]", "- [x]"),
        ("- [x]", "- [X]"),
        ("- [X]", "- [ ]"),
        ("-", "- [x]"),
        ("- [x]", "-"),
    ] {
        for level in 0..4 {
            let mut source = String::new();
            for depth in 0..4 {
                source.push_str(&format!(
                    "{}- parent\n{}  more\n",
                    " ".repeat(depth * 4),
                    " ".repeat(depth * 4)
                ));
            }
            source.push_str(&format!(
                "{}{first} sibling\n{}{next} changed",
                " ".repeat(level * 4),
                " ".repeat(level * 4)
            ));
            sources.push(source);
        }
    }
    sources.extend(plain_inline_sources().map(str::to_owned));
    sources.push("- p\n  more\n  - c".to_owned());
    sources
}

fn production_docs(source: &str) -> [Ydoc; 2] {
    let successor =
        successor(source).unwrap_or_else(|error| panic!("successor {source:?}: {error}"));
    let doc = Ydoc::wire();
    doc.apply(&successor.update).unwrap();
    let relation = Ydoc::wire();
    relation
        .seed_collection_relation_markdown(source)
        .unwrap_or_else(|error| panic!("relation {source:?}: {error}"));
    [doc, relation]
}

/// Every source seeds both builders with the body the reader reads, and the
/// first fold may restyle the note but folding what it writes changes
/// nothing.
#[test]
fn every_source_seeds_both_builders_and_folds_stably() {
    let sources = nested_sources()
        .into_iter()
        .chain(shapes())
        .chain(flat_inline_sources())
        .map(str::to_owned)
        .chain(generated_sources());
    // The writer writes a heading that holds a line break as an ATX heading,
    // which ends at the break, and gives neighbouring lists of one kind one
    // marker, so they read back as one list. These are unstable and a
    // relation does not seed them: #4139.
    let writer_gap = |source: &str| {
        let mut lines = source.lines().rev().map(str::trim_start);
        let changes_marker = match (lines.next(), lines.next()) {
            (Some(last), Some(before)) => [
                ("-", "*"),
                ("*", "+"),
                ("+", "-"),
                ("1.", "2)"),
                ("1)", "2."),
            ]
            .iter()
            .any(|(first, next)| {
                before == format!("{first} sibling") && last == format!("{next} changed")
            }),
            _ => false,
        };
        changes_marker || ["- a\n  b\n  ===\n  - c\n", "- a\n  b\n  --\n  - c"].contains(&source)
    };
    // A renderer reads these lines as HTML, or hides a link definition, which
    // the document holds as text, so the source is not kept and a relation
    // does not seed it.
    let defines_a_link = |source: &str| {
        source.lines().any(|line| {
            line.trim_start_matches([' ', '>']).starts_with('[') && line.contains("]: ")
        })
    };
    let html = [
        "- parent\n\n  <div\n  - child",
        "- parent\n\n  <div \n  - child",
        "- parent\n\n  <pre\n  - child",
        "- parent\n\n  <span>inline</span>\n  - child",
        "- parent\n\n  <meta>text\n  - child",
        "- a\n\n  <div>html</div>",
        "- a\n\n  ```\n  code\n  ````\n  <div>\n  ```\n",
        "- a\n\n  ```\n  code\n   ```\n  <div>\n  ```\n",
    ];
    let mut unstable = Vec::new();
    for source in sources {
        let read = Ydoc::wire();
        read.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
            .unwrap_or_else(|error| panic!("read {source:?}: {error}"));
        let body = read.canonical_content()["body"].clone();
        let shown_unlike = html.contains(&source.as_str()) || defines_a_link(&source);
        if writer_gap(&source) || shown_unlike {
            assert!(
                matches!(
                    Ydoc::wire().seed_collection_relation_markdown(&source),
                    Err(CollabError::MarkdownNotRepresentable)
                ),
                "{source:?}"
            );
        }
        if writer_gap(&source) {
            continue;
        }
        if shown_unlike {
            let doc = Ydoc::wire();
            doc.apply(&successor(&source).unwrap().update).unwrap();
            assert_eq!(doc.canonical_content()["body"], body, "{source:?}");
        } else {
            for built in production_docs(&source) {
                assert_eq!(built.canonical_content()["body"], body, "{source:?}");
            }
        }
        let canonical = read.project_richdoc().unwrap();
        let again = Ydoc::wire();
        again
            .rewrite_content_to_markdown(ContentKind::Richdoc, &canonical)
            .unwrap();
        // The writer escapes the backtick that would open a fence, which
        // reads back as an escaped backtick: the same text and the same file.
        let escapes_a_fence = source.starts_with("```bad`info\n");
        if (again.canonical_content()["body"] != body && !escapes_a_fence)
            || again.project_richdoc().unwrap() != canonical
        {
            unstable.push(source);
        }
    }
    assert!(unstable.is_empty(), "{unstable:?}");
}

#[test]
fn a_nested_fold_reads_the_file() {
    for source in [
        "- parent\n  - child",
        "1. parent\n    1. child",
        "- [X] parent\n  - [x] child",
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Original")
            .unwrap();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .unwrap_or_else(|error| panic!("{source:?}: {error}"));
        let read = Ydoc::wire();
        read.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        assert_eq!(
            doc.canonical_content()["body"],
            read.canonical_content()["body"],
            "{source:?}"
        );
    }
}

fn shapes() -> [&'static str; 24] {
    [
        "- a\n  b\n  ===\n  - c\n",
        "- a\n  ---",
        "- a\n  ===",
        "- a\n  --",
        "- a\n  =",
        "- a\n   -",
        "- a\n\n  # heading",
        "- a\n\n  > quote",
        "- a\n\n  | h |\n  | --- |\n  | v |",
        "- a\n\n  <div>html</div>",
        "- parent\n\n  </custom >\n  - child",
        "- parent\n\n  </custom\t>\n  - child",
        "- parent\n\n  </custom> \n  - child",
        "- parent\n\n  <my_tag>\n  - child",
        "- parent\n\n  <meta>text\n  - child",
        "- a\n\n      indented code",
        "- a\n\n  ~~~\n  code\n  ~~~",
        "-\n  - child",
        "- a\n  - child\nlazy",
        "- a\n\t- child",
        "- parent\n  - \tchild",
        "- parent\n  - [x]\tchild",
        "- a\n   - child",
        "- a\n     - child",
    ]
}

fn inline_sources() -> [&'static str; 81] {
    [
        "- [label][ref]\n  - child\n\n[ref]: https://example.com",
        "- <https://example.com>\n  - child",
        "- parent\n\n  <div:foo>\n  - child",
        "- parent\n\n  <span>inline</span>\n  - child",
        "- `Vec<T>`\n  - child",
        "- [link](https://example.com)\n  - child",
        "- run `a -> b`\n  - child",
        "- `a && b`\n  - child",
        "- $x > 0$\n  - child",
        "- $a < b$\n  - child",
        "- see [[Tom & Jerry]]\n  - child",
        "- [[Meeting notes]]\n  - follow-up",
        "- ![](shot.png)\n  - caption",
        "- parent\n  [[Meeting notes]]\n  - child",
        "- parent\n  ![](shot.png)\n  - child",
        "- [x] [[Meeting notes]]\n  - child",
        "- [ ] ![](shot.png)\n  - child",
        "- {{atom:example name=Tom&Jerry}}\n  - child",
        "- {{atom:example}}\n  - child",
        "- $x$\n  - child",
        "- a > b\n  - child",
        "- a & b\n  - child",
        "- a < b\n  - child",
        "- Vec<T>\n  - child",
        "- [literal brackets]\n  - child",
        "- parent\n\n  <prelude>inline</prelude>\n  - child",
        "- parent\n\n  <_foo>\n  - child",
        "- see [docs](https://example.com)\n  - child",
        "1. [ ] parent\n    1. [X] child",
        "3) [X] parent\n    1) [ ] child",
        "- see https://example.com\n  - child\n",
        "- www.example.com\n  - child\n",
        "- mail a@b.co\n  - child\n",
        "- _note_\n  - child\n",
        "- __note__\n  - child\n",
        "- ``code``\n  - child",
        "- ` x `\n  - child",
        "- a  \n  b\n  - child",
        "- a\\\n  b\n  - child",
        "- ==a=b==\n  - child",
        "- ++underline++\n  - child",
        "- WWW.example.com\n  - child",
        "- a ~ b\n  - child",
        "- a # b\n  - child",
        "- a = b\n  - child",
        "- a + b\n  - child",
        "- a | b\n  - child",
        "- a \\ b\n  - child",
        "- a ^ b\n  - child",
        "- a % b\n  - child",
        "- `code\n  more`\n  - child",
        "- unmatched `code\n  - child",
        "- `   `\n  - child",
        "- parent\n\n  ```c\\+\\+\n  code\n  ```\n  - child",
        "- ~~**done**~~ shipped\n  - notes\n",
        "- ~~**a**~~\n  - child\n",
        "- ~~*a*~~\n  - child\n",
        "- ~~***a***~~\n  - child\n",
        "- **~~*a*~~**\n  - child\n",
        "- **~~a~~**\n  - child",
        "- *~~a~~*\n  - child",
        "- *a *b* c*\n  - child",
        "- **a **b** c**\n  - child",
        "- ****a****\n  - child",
        "- **a* b\n  - child",
        "- ***a**\n  - child",
        "- a\rb\n  - child",
        "- 2*3*4\n  - child",
        "- a * b\n  - child",
        "- **bold**\n  - child",
        "- *italic*\n  - child",
        "- ~~strike~~\n  - child",
        "- `code`\n  - child",
        "- `*plain* / : -`\n  - child",
        "- **bold** and *emphasis*\n  - ~~strike~~",
        "- curly ’ quote\n  - child",
        "- an — em dash\n  - child",
        "- emoji 😀\n  - child",
        "- parent\n  - child\n\nAn ’ apostrophe",
        "- parent\n  - child\n\n# An — em dash",
        "- parent\n  - child\n\n<!-- dohc:table row-heights=1:40 -->\n| h |\n| --- |\n| 😀 |",
    ]
}

fn flat_inline_sources() -> [&'static str; 11] {
    [
        "- see https://example.com",
        "- www.example.com",
        "- mail a@b.co",
        "- _note_",
        "- __note__",
        "- run `a -> b`",
        "- `a && b`",
        "- $a < b$",
        "- [[Meeting notes]]",
        "- ![](shot.png)",
        "- {{atom:example name=Tom&Jerry}}",
    ]
}

/// A fresh successor whose source differs from its projection keeps the
/// source only within the public witness band.
#[test]
fn a_fresh_successor_obeys_the_witness_band() {
    for bytes in [
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES,
        crate::limits::MAX_PUBLIC_MARKDOWN_BYTES + 1,
    ] {
        let source = "* ".to_owned() + &"p".repeat(bytes - 2);
        let digest = crate::hex_sha256(source.as_bytes());
        let key = crate::DocKey::new("workspace", "main", "object").unwrap();
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: "claim",
            predecessor_state_vector_sha256: "vector",
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: "preimage",
            content_kind: ContentKind::Richdoc,
            result_sha256: &digest,
        });
        let result = fresh_successor_base(&identity, &source);
        assert_eq!(
            result.is_ok(),
            bytes <= crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        );
    }
}

#[test]
fn a_forged_witness_is_not_authority() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "- parent\n  - child")
        .unwrap();
    let canonical = doc.project_richdoc().unwrap();
    doc.record_validated_markdown_source_reference("* forged\n  * child")
        .unwrap();
    assert!(doc.preserved_markdown_source(&canonical).is_none());
    doc.validate_public_baseline(&doc.encode_full_state())
        .unwrap();
    assert_eq!(doc.project_richdoc().unwrap(), canonical);
    assert_ne!(canonical, "* forged\n  * child");
}

#[test]
fn a_frontmatter_stage_keeps_an_unwitnessed_body() {
    let initial = "---\nstatus: open\n---\n* parent\n\n    * child\n";
    let chosen = initial.replace("open", "done");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, initial)
        .unwrap();
    assert!(doc.markdown_source_reference().is_none());
    let body = doc.canonical_content()["body"].clone();
    doc.replace_frontmatter_for_fold(&chosen).unwrap();
    assert_eq!(doc.canonical_content()["body"], body);
    assert_eq!(
        doc.preserved_markdown_source(&doc.project_richdoc().unwrap())
            .as_deref(),
        Some(chosen.as_str())
    );

    let _ = doc.richdoc_append_paragraph("Unsettled body edit");
    let edited = doc.canonical_content()["body"].clone();
    doc.replace_frontmatter_for_fold(initial).unwrap();
    assert_eq!(doc.canonical_content()["body"], edited);
    let canonical = doc.project_richdoc().unwrap();
    assert!(doc.preserved_markdown_source(&canonical).is_none());
    assert_eq!(
        doc.settled_markdown_source(&canonical, || Ok::<_, ()>(Some(initial.to_owned()))),
        Ok(None)
    );
}

/// The sources the desktop's `nestedBuilders.test.ts` compares with its own
/// import, as both production builders build them.
const DESKTOP_SOURCES: [&str; 3] = [
    "- parent\n  - child\n    - grandchild",
    "3) parent\n    0) child\n        - grandchild",
    "- [ ] parent\n\n  * [x] child\n    - grandchild\n\n  second paragraph",
];

fn witness(doc: &Ydoc) -> Value {
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    let txn = doc.doc.transact();
    serde_json::json!([
        MARKDOWN_SOURCE_META_KEY,
        MARKDOWN_SOURCE_SHA_META_KEY,
        MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY
    ]
    .map(|key| match meta.get(&txn, key) {
        Some(Out::Any(Any::String(value))) => serde_json::json!(value.as_ref()),
        _ => Value::Null,
    }))
}

fn desktop_row(source: &str) -> Value {
    use base64::Engine as _;
    let docs = production_docs(source);
    serde_json::json!({
        "source": source,
        "canonical": docs[0].project_richdoc().unwrap(),
        "body": docs[0].canonical_content()["body"],
        "builders": docs.iter().map(|doc| serde_json::json!({
            "nativeBase64": base64::engine::general_purpose::STANDARD.encode(doc.encode_full_state()),
            "witness": witness(doc),
        })).collect::<Vec<_>>(),
    })
}

/// The desktop's fixture holds what the builders build now: each builder's
/// update replays to the same body and witness.
#[test]
fn the_desktop_fixture_holds_what_the_builders_build() {
    use base64::Engine as _;
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested-source-builders.json"
    ))
    .unwrap();
    assert_eq!(fixture.len(), DESKTOP_SOURCES.len());
    for (row, source) in fixture.iter().zip(DESKTOP_SOURCES) {
        let built = desktop_row(source);
        for key in ["source", "canonical", "body"] {
            assert_eq!(row[key], built[key], "{source:?} {key}");
        }
        let builders = row["builders"].as_array().unwrap();
        assert_eq!(builders.len(), 2);
        for (builder, expected) in builders.iter().zip(built["builders"].as_array().unwrap()) {
            assert_eq!(builder["witness"], expected["witness"], "{source:?}");
            let replay = Ydoc::wire();
            replay
                .apply(
                    &base64::engine::general_purpose::STANDARD
                        .decode(builder["nativeBase64"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
            assert_eq!(
                replay.canonical_content()["body"],
                built["body"],
                "{source:?}"
            );
            assert_eq!(witness(&replay), expected["witness"], "{source:?}");
        }
    }
}

#[test]
#[ignore = "writes the desktop fixture"]
fn write_the_desktop_fixture() {
    let rows: Vec<Value> = DESKTOP_SOURCES.into_iter().map(desktop_row).collect();
    std::fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/rust-engine-program/nested-source-builders.json"
        ),
        serde_json::to_string_pretty(&rows).unwrap() + "\n",
    )
    .unwrap();
}
