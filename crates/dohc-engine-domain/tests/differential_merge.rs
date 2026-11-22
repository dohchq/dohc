use dohc_engine_domain::{MarkdownMergeResult, merge_markdown};

/// The same cases and outcomes as the test loopback engine's merge test in
/// `packages/workspace-engine-client`, so the two merges stay in step.
const CASES: [(&str, &str, &str, Option<&str>); 15] = [
    ("base", "same", "same", Some("same")),
    ("base", "base", "remote", Some("remote")),
    ("a\nb\nc", "A\nb\nc", "a\nb\nC", Some("A\nb\nC")),
    ("a\nb", "local\nb", "remote\nb", None),
    ("a\nb", "replacement\nb", "inserted\na\nb", None),
    ("a\nb", "a\nb\nlocal", "a\nb\nremote", None),
    ("x\nx\na\nb", "x\na\nb", "x\na\nB", Some("x\na\nB")),
    (
        "\n\n\n---\n---",
        "\n\n---",
        "\n\n\n\n---",
        Some("\n\n\n---"),
    ),
    (
        "One.\n\nTwo.\n\nThree.",
        "One.\n\nLocal.\n\nTwo.\n\nThree.",
        "One.\n\nTwo.\n\nRemote.\n\nThree.",
        Some("One.\n\nLocal.\n\nTwo.\n\nRemote.\n\nThree."),
    ),
    (
        "\nB\nX\n---\n---",
        "\nB\n---\nX\n---",
        "B\nX\n\n---\nC",
        None,
    ),
    ("\nA", "\n", "B\n", None),
    ("", "A\n", "\nB", None),
    (
        "A\n---\n---\n---\nB",
        "B\n---\nA\n---\n---",
        "A\n---\n---\nB",
        None,
    ),
    (
        "One.\n\nTwo.",
        "New.\n\nOne.",
        "One.\nAdded.\nMore.\n\nTwo.",
        None,
    ),
    (
        "A\n---\nC\n---\nD\nE",
        "D\nA\n---\nC\n---\nE",
        "A\n---\n---\nD\nE\nC",
        Some("D\nA\n---\n---\nE\nC"),
    ),
];

#[test]
fn merge_markdown_matches_the_shared_cases() {
    for (base, local, remote, expected) in CASES {
        let expected = match expected {
            Some(text) => MarkdownMergeResult::Merged(text.to_owned()),
            None => MarkdownMergeResult::Conflict,
        };
        assert_eq!(
            merge_markdown(base, local, remote),
            expected,
            "{base:?} {local:?} {remote:?}"
        );
    }
}
