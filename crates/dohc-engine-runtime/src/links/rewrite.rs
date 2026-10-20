use super::{
    parser,
    resolver::{self, Resolver},
};
use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub range: Range<usize>,
    pub literal: String,
}

pub(crate) fn targets(text: &str) -> Option<Vec<Target>> {
    let offsets: Vec<usize> = text
        .char_indices()
        .flat_map(|(i, c)| std::iter::repeat_n(i, c.len_utf16()))
        .chain(std::iter::once(text.len()))
        .collect();
    parser::extract(text)
        .ok()?
        .into_iter()
        .filter(|o| o.kind == "wikilink")
        .map(|o| {
            let start = *offsets.get(o.start_utf16)? + 2;
            let end = *offsets.get(o.end_utf16)? - 2;
            let raw = text.get(start..end)?.split('|').next()?;
            let left = raw.len() - raw.trim_start().len();
            let range = start + left..start + raw.trim_end().len();
            Some(Target {
                literal: text.get(range.clone())?.into(),
                range,
            })
        })
        .collect()
}

pub(crate) fn replace(text: &str, replacements: &[(Range<usize>, String)]) -> String {
    let mut result = text.to_owned();
    for (range, value) in replacements.iter().rev() {
        result.replace_range(range.clone(), value);
    }
    result
}

fn relative_path(source: &str, target: &str) -> String {
    let directory = source
        .rsplit_once('/')
        .map_or("", |(directory, _)| directory);
    let from: Vec<_> = directory
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let to: Vec<_> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let parents = "../".repeat(from.len() - common);
    format!(
        "{}{}",
        if parents.is_empty() { "./" } else { &parents },
        to[common..].join("/")
    )
}

fn encoded_path(path: &str) -> String {
    path.replace('%', "%25")
        .replace('#', "%23")
        .replace('?', "%3F")
        .replace(']', "%5D")
        .replace('|', "%7C")
}

pub(crate) fn forward(
    text: &str,
    source: &str,
    old: &str,
    new: &str,
    before: &Resolver,
    after: &Resolver,
) -> Option<(String, usize)> {
    let mut edits = Vec::new();
    for target in targets(text)? {
        if before.resolve(source, &target.literal) != Some(old) {
            continue;
        }
        let (_, fragment) = target
            .literal
            .split_once('#')
            .map_or((target.literal.as_str(), ""), |(name, _)| {
                (name, &target.literal[name.len()..])
            });
        let name = resolver::target(&target.literal)?;
        let new_name = if resolver::without_extension(&name) == name {
            resolver::without_extension(new)
        } else {
            new
        };
        let mut candidate = if name.starts_with("./") || name.starts_with("../") {
            relative_path(source, new_name)
        } else if name.contains('/') {
            if name.starts_with('/') {
                format!("/{new_name}")
            } else {
                new_name.into()
            }
        } else {
            new_name.rsplit('/').next().unwrap_or(new_name).into()
        };
        candidate = encoded_path(&candidate);
        if after.resolve(source, &candidate) != Some(new) {
            candidate = format!("/{}", encoded_path(new));
        }
        if after.resolve(source, &candidate) != Some(new) {
            return None;
        }
        edits.push((target.range, format!("{candidate}{fragment}")));
    }
    let count = edits.len();
    Some((replace(text, &edits), count))
}

fn myers<T: PartialEq>(a: &[T], b: &[T]) -> Option<Vec<(Range<usize>, usize)>> {
    use std::collections::HashMap;
    let mut frontier = HashMap::from([(1isize, 0usize)]);
    let mut trace = Vec::new();
    'search: for d in 0..=a.len() + b.len() {
        // Bound edit-distance memory; never guess after exhausting it.
        if d > 1000 {
            return None;
        }
        trace.push(frontier.clone());
        for k in (-(d as isize)..=d as isize).step_by(2) {
            let down =
                k == -(d as isize) || (k != d as isize && frontier[&(k - 1)] < frontier[&(k + 1)]);
            let mut x = if down {
                frontier[&(k + 1)]
            } else {
                frontier[&(k - 1)] + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < a.len() && y < b.len() && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            frontier.insert(k, x);
            if x == a.len() && y == b.len() {
                break 'search;
            }
        }
    }
    let (mut x, mut y) = (a.len(), b.len());
    let mut ranges = Vec::new();
    for (d, previous) in trace.iter().enumerate().rev() {
        let k = x as isize - y as isize;
        let (px, py) = if d == 0 {
            (0, 0)
        } else {
            let down =
                k == -(d as isize) || (k != d as isize && previous[&(k - 1)] < previous[&(k + 1)]);
            let pk = if down { k + 1 } else { k - 1 };
            let px = previous[&pk];
            (px, (px as isize - pk) as usize)
        };
        let end = x;
        while x > px && y > py {
            x -= 1;
            y -= 1;
        }
        if x < end {
            ranges.push((x..end, y));
        }
        x = px;
        y = py;
    }
    ranges.reverse();
    Some(ranges)
}
// Strip common edges before Myers, so a long insertion costs no edit frontier.
fn matching<T: PartialEq>(a: &[T], b: &[T]) -> Vec<(Range<usize>, usize)> {
    let prefix = a.iter().zip(b).take_while(|(a, b)| a == b).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut ranges = Vec::new();
    if prefix > 0 {
        ranges.push((0..prefix, 0));
    }
    // An exhausted hunk remains changed; it cannot invalidate exact edges.
    if let Some(middle) = myers(&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]) {
        ranges.extend(
            middle
                .into_iter()
                .map(|(r, b)| (r.start + prefix..r.end + prefix, b + prefix)),
        );
    }
    if suffix > 0 {
        ranges.push((a.len() - suffix..a.len(), b.len() - suffix));
    }
    ranges
}

/// Diff lines first, then characters only inside the changed line hunks.
fn unchanged_ranges(before: &str, after: &str) -> Option<Vec<(Range<usize>, usize)>> {
    let a: Vec<_> = before.split_inclusive('\n').collect();
    let b: Vec<_> = after.split_inclusive('\n').collect();
    let offsets = |lines: &[&str]| {
        std::iter::once(0)
            .chain(lines.iter().scan(0, |sum, line| {
                *sum += line.len();
                Some(*sum)
            }))
            .collect::<Vec<_>>()
    };
    let (ao, bo) = (offsets(&a), offsets(&b));
    let mut ranges = Vec::new();
    let (mut x, mut y) = (0, 0);
    for (r, start) in matching(&a, &b)
        .into_iter()
        .chain([(a.len()..a.len(), b.len())])
    {
        let left = &before[ao[x]..ao[r.start]];
        let right = &after[bo[y]..bo[start]];
        let chars = |s: &str| {
            s.char_indices()
                .map(|(i, _)| i)
                .chain([s.len()])
                .collect::<Vec<_>>()
        };
        let (ac, bc) = (chars(left), chars(right));
        for (cr, cs) in matching(
            &left.chars().collect::<Vec<_>>(),
            &right.chars().collect::<Vec<_>>(),
        ) {
            ranges.push((ao[x] + ac[cr.start]..ao[x] + ac[cr.end], bo[y] + bc[cs]));
        }
        if !r.is_empty() {
            ranges.push((ao[r.start]..ao[r.end], bo[start]));
        }
        (x, y) = (r.end, start + r.len());
    }
    let mut joined: Vec<(Range<usize>, usize)> = Vec::new();
    for (r, start) in ranges {
        if let Some((prior, p)) = joined.last_mut()
            && prior.end == r.start
            && *p + prior.len() == start
        {
            prior.end = r.end;
        } else {
            joined.push((r, start));
        }
    }
    Some(joined)
}
pub(crate) fn inverse(before: &str, after: &str, head: &str) -> Option<String> {
    #[cfg(test)]
    if let Some(mutant) = tests::mutant(before, after, head) {
        return Some(mutant);
    }
    let originals = targets(before)?;
    let rewritten = targets(after)?;
    if originals.len() != rewritten.len() {
        return None;
    }
    let held = targets(head)?;
    let unchanged = unchanged_ranges(after, head)?;
    let mut edits = Vec::new();
    for (old, new) in originals.iter().zip(&rewritten) {
        if old.literal == new.literal {
            continue;
        }
        let (range, mapped) = unchanged
            .iter()
            .find(|(range, _)| range.start <= new.range.start && range.end >= new.range.end)?;
        let start = mapped + new.range.start - range.start;
        let mapped_range = start..start + new.range.len();
        if !held
            .iter()
            .any(|target| target.range == mapped_range && target.literal == new.literal)
        {
            return None;
        }
        edits.push((mapped_range, old.literal.clone()));
    }
    Some(replace(head, &edits))
}

#[cfg(test)]
mod tests {
    use super::*;
    std::thread_local! { static MUTATION: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
    pub(super) fn mutant(before: &str, after: &str, head: &str) -> Option<String> {
        match MUTATION.get() {
            1 => Some(head.replace(&targets(after)?[0].literal, &targets(before)?[0].literal)),
            2 => Some(before.into()),
            _ => None,
        }
    }
    #[test]
    fn inverse_oracle_kills_literal_search_and_before_body_mutations() {
        let before = "[[old|label]] tail";
        let after = "[[new|label]] tail";
        let head = "typing [[new|edited label]] tail [[new]]";
        let oracle = || {
            assert_eq!(
                inverse(before, after, head).unwrap(),
                "typing [[old|edited label]] tail [[new]]"
            )
        };
        oracle();
        for mode in [1, 2] {
            MUTATION.set(mode);
            assert!(
                std::panic::catch_unwind(oracle).is_err(),
                "mutation {mode} survived"
            );
        }
        MUTATION.set(0);
        if let Ok(directory) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join("mutations.json"),
                r#"{"literalSearch":"killed","beforeBody":"killed","openSessionFence":"5a-2"}"#,
            )
            .unwrap();
        }
    }

    #[test]
    fn inverse_preserves_typing_labels_unicode_and_new_links() {
        let before = "😀 [[old#part|label]] end";
        let after = "😀 [[new#part|label]] end";
        let head = "typed 😀 [[new#part|changed label]] end [[new#part]]";
        assert_eq!(
            inverse(before, after, head).unwrap(),
            "typed 😀 [[old#part|changed label]] end [[new#part]]"
        );
        assert!(inverse(before, after, "😀 [[different#part|label]] end").is_none());
    }

    #[test]
    fn forward_keeps_labels_fragments_and_ambiguous_stems() {
        let paths = ["a/old.md", "b/old.md", "source.md"];
        let before = Resolver::new(paths.map(str::to_owned));
        let after = Resolver::new(["new.md", "b/old.md", "source.md"].map(str::to_owned));
        let (text, count) = forward(
            "[[old]] [[a/old#part|label]] [old](a/old.md)",
            "source.md",
            "a/old.md",
            "new.md",
            &before,
            &after,
        )
        .unwrap();
        assert_eq!(count, 1);
        assert_eq!(text, "[[old]] [[new#part|label]] [old](a/old.md)");
    }

    #[test]
    fn inverse_handles_long_paragraphs_in_changed_and_unchanged_lines() {
        for head in [
            format!("[[new|label]] tail {}", "typed ".repeat(2000)),
            format!("{} [[new|label]] tail", "typed ".repeat(2000)),
            format!(
                "{}\n[[new|label]] tail\n{}",
                "typed ".repeat(2000),
                "more ".repeat(2000)
            ),
            format!("[[new|{}]] tail", "label ".repeat(2000)),
        ] {
            assert_eq!(
                inverse("[[old|label]] tail", "[[new|label]] tail", &head).unwrap(),
                head.replacen("[[new|", "[[old|", 1)
            );
        }
    }

    #[test]
    fn forward_preserves_already_escaped_fragment_bytes() {
        let before = Resolver::new(["old.md".into()]);
        let after = Resolver::new(["new].md".into()]);
        let result = forward(
            r"[[old#part\name|label]]",
            "source.md",
            "old.md",
            "new].md",
            &before,
            &after,
        )
        .unwrap();
        assert_eq!(result, (r"[[new%5D#part\name|label]]".into(), 1));
    }

    #[test]
    fn myers_equal_ranges_are_exact_for_small_edit_pairs() {
        let inputs = ["", "a", "b", "aa", "ab", "ba", "bb", "😀a", "a😀"];
        for a in inputs {
            for b in inputs {
                for (range, start) in unchanged_ranges(a, b).unwrap() {
                    assert_eq!(
                        &a[range.clone()],
                        &b[start..start + range.len()],
                        "{a:?} -> {b:?}"
                    );
                }
            }
        }
    }
}
