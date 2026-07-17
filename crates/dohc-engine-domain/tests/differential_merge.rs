//! TS-derived golden fixture for the pure R06 markdown merger. This is a
//! literal oracle string, not a Rust round-trip through a second Rust helper.

use dohc_engine_domain::{MarkdownMergeResult, merge_markdown};

fn outcome(base: &str, local: &str, remote: &str) -> String {
    match merge_markdown(base, local, remote) {
        MarkdownMergeResult::Merged(content) => format!("merged:{content}"),
        MarkdownMergeResult::Conflict => "conflict".to_owned(),
    }
}

#[test]
fn merge_markdown_matches_ts_derived_golden() {
    let actual = [
        outcome("base", "same", "same"),
        outcome("base", "base", "remote"),
        outcome("a\nb\nc", "A\nb\nc", "a\nb\nC"),
        outcome("a\nb", "local\nb", "remote\nb"),
        outcome("a\nb", "replacement\nb", "inserted\na\nb"),
    ]
    .join("\n");
    let golden = "merged:same\n\
                  merged:remote\n\
                  merged:A\n\
                  b\n\
                  C\n\
                  conflict\n\
                  conflict";
    assert_eq!(actual, golden);
}
