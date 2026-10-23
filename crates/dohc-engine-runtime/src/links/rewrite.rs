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

// Charge frontier steps and matching comparisons across both diff levels.
// Linear scans and containment keep ordinary paragraph insertions cheap.
const DIFF_STEPS: usize = 8_000_000;
fn step(remaining: &mut usize) -> Option<()> {
    *remaining = remaining.checked_sub(1)?;
    Some(())
}

// Myers' bidirectional frontiers find a split using linear memory.
fn bisect<T: PartialEq>(a: &[T], b: &[T], remaining: &mut usize) -> Option<(usize, usize)> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let limit = (n + m + 1) / 2;
    let offset = limit + 1;
    let mut forward = vec![-1; (2 * limit + 3) as usize];
    let mut reverse = forward.clone();
    forward[(offset + 1) as usize] = 0;
    reverse[(offset + 1) as usize] = 0;
    let delta = n - m;
    let odd = delta % 2 != 0;
    let (mut fs, mut fe, mut rs, mut re) = (0, 0, 0, 0);
    for d in 0..=limit {
        for k in ((-d + fs)..=(d - fe)).step_by(2) {
            step(remaining)?;
            let slot = (offset + k) as usize;
            let mut x = if k == -d || (k != d && forward[slot - 1] < forward[slot + 1]) {
                forward[slot + 1]
            } else {
                forward[slot - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                step(remaining)?;
                x += 1;
                y += 1;
            }
            forward[slot] = x;
            if x > n {
                fe += 2;
            } else if y > m {
                fs += 2;
            } else if odd {
                let other = offset + delta - k;
                if other >= 0
                    && other < (reverse.len() as isize)
                    && reverse[other as usize] >= 0
                    && x >= n - reverse[other as usize]
                {
                    return Some((x as usize, y as usize));
                }
            }
        }
        for k in ((-d + rs)..=(d - re)).step_by(2) {
            step(remaining)?;
            let slot = (offset + k) as usize;
            let mut x = if k == -d || (k != d && reverse[slot - 1] < reverse[slot + 1]) {
                reverse[slot + 1]
            } else {
                reverse[slot - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[(n - x - 1) as usize] == b[(m - y - 1) as usize] {
                step(remaining)?;
                x += 1;
                y += 1;
            }
            reverse[slot] = x;
            if x > n {
                re += 2;
            } else if y > m {
                rs += 2;
            } else if !odd {
                let other = offset + delta - k;
                if other >= 0
                    && other < (forward.len() as isize)
                    && forward[other as usize] >= 0
                    && forward[other as usize] >= n - x
                {
                    let start = forward[other as usize];
                    return Some((start as usize, (start - delta + k) as usize));
                }
            }
        }
    }
    None
}

fn matching<T: PartialEq>(
    a: &[T],
    b: &[T],
    remaining: &mut usize,
) -> Option<Vec<(Range<usize>, usize)>> {
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
    let (left, right) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    if !left.is_empty() && !right.is_empty() {
        let (x, y) = bisect(left, right, remaining)?;
        if (x, y) != (0, 0) && (x, y) != (left.len(), right.len()) {
            for (r, start) in matching(&left[..x], &right[..y], remaining)? {
                ranges.push((r.start + prefix..r.end + prefix, start + prefix));
            }
            for (r, start) in matching(&left[x..], &right[y..], remaining)? {
                ranges.push((r.start + prefix + x..r.end + prefix + x, start + prefix + y));
            }
        }
    }
    if suffix > 0 {
        ranges.push((a.len() - suffix..a.len(), b.len() - suffix));
    }
    Some(ranges)
}

/// Diff lines first, then characters only inside the changed line hunks.
fn unchanged_ranges(
    before: &str,
    after: &str,
    remaining: &mut usize,
) -> Option<Vec<(Range<usize>, usize)>> {
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
    for (r, start) in matching(&a, &b, remaining)?
        .into_iter()
        .chain([(a.len()..a.len(), b.len())])
    {
        let left = &before[ao[x]..ao[r.start]];
        let right = &after[bo[y]..bo[start]];
        // Containment and empty hunks need no frontier search or character arrays.
        if !left.is_empty() && !right.is_empty() {
            if let Some(offset) = right.find(left) {
                ranges.push((ao[x]..ao[r.start], bo[y] + offset));
            } else if let Some(offset) = left.find(right) {
                ranges.push((ao[x] + offset..ao[x] + offset + right.len(), bo[y]));
            } else {
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
                    remaining,
                )? {
                    ranges.push((ao[x] + ac[cr.start]..ao[x] + ac[cr.end], bo[y] + bc[cs]));
                }
            }
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
#[cfg(test)]
pub(crate) fn inverse(before: &str, after: &str, head: &str) -> Option<String> {
    inverse_budgeted(before, after, head).ok().flatten()
}

pub(crate) fn map_ranges(
    before: &str,
    after: &str,
    ranges: &[Range<usize>],
) -> Option<Vec<Option<Range<usize>>>> {
    let mut steps = DIFF_STEPS;
    let unchanged = unchanged_ranges(before, after, &mut steps)?;
    Some(
        ranges
            .iter()
            .map(|r| {
                let (source, start) = unchanged
                    .iter()
                    .find(|(source, _)| source.start <= r.start && source.end >= r.end)?;
                let start = start + r.start - source.start;
                Some(start..start + r.len())
            })
            .collect(),
    )
}

pub(crate) fn inverse_budgeted(
    before: &str,
    after: &str,
    head: &str,
) -> Result<Option<String>, ()> {
    let mut remaining = DIFF_STEPS;
    inverse_with_steps(before, after, head, &mut remaining)
}

fn inverse_with_steps(
    before: &str,
    after: &str,
    head: &str,
    remaining: &mut usize,
) -> Result<Option<String>, ()> {
    let unchanged = unchanged_ranges(after, head, remaining).ok_or(())?;
    Ok(inverse_in_ranges(before, after, head, unchanged))
}

fn inverse_in_ranges(
    before: &str,
    after: &str,
    head: &str,
    unchanged: Vec<(Range<usize>, usize)>,
) -> Option<String> {
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
        for (case, head) in [
            format!("[[new|label]] tail {}", "typed ".repeat(2000)),
            format!("{} [[new|label]] tail", "typed ".repeat(2000)),
            format!(
                "{}\n[[new|label]] tail\n{}",
                "typed ".repeat(2000),
                "more ".repeat(2000)
            ),
            format!("[[new|{}]] tail", "label ".repeat(60)),
            format!(
                "{}[[new|label]] tail{}",
                "before ".repeat(2000),
                "after ".repeat(2000)
            ),
        ]
        .into_iter()
        .enumerate()
        {
            assert!(
                targets(&head).unwrap().len() == 1,
                "case {case}: fixture must retain a parsed wikilink"
            );
            assert_eq!(
                inverse("[[old|label]] tail", "[[new|label]] tail", &head)
                    .unwrap_or_else(|| panic!("long paragraph case {case}")),
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
    fn megabyte_append_preserves_the_unchanged_target() {
        let after = "a short note ending [[new]]";
        let head = format!("{after}{}", " appended text".repeat(80_660));
        assert!(head.len() >= 1024 * 1024);
        assert_eq!(
            inverse_budgeted("a short note ending [[old]]", after, &head),
            Ok(Some(head.replacen("[[new]]", "[[old]]", 1)))
        );
    }

    #[test]
    fn difficult_hunks_exhaust_real_steps_deterministically() {
        let after = format!("{}[[new]]{}", "a".repeat(8192), "b".repeat(8192));
        let before = after.replace("[[new]]", "[[old]]");
        let head = format!("{}[[new]]{}", "c".repeat(8192), "d".repeat(8192));
        for _ in 0..2 {
            let mut remaining = DIFF_STEPS;
            assert_eq!(
                inverse_with_steps(&before, &after, &head, &mut remaining),
                Err(())
            );
            assert_eq!(remaining, 0, "the search must spend the real budget");
        }
    }

    #[test]
    fn myers_matches_have_the_optimal_length() {
        let inputs: Vec<Vec<u8>> = (0..128u8)
            .map(|bits| {
                let len = (8 - bits.leading_zeros()).saturating_sub(1);
                (0..len).map(|i| (bits >> i) & 1).collect()
            })
            .collect();
        for a in &inputs {
            for b in &inputs {
                let mut lcs = vec![vec![0; b.len() + 1]; a.len() + 1];
                for i in 0..a.len() {
                    for j in 0..b.len() {
                        lcs[i + 1][j + 1] = if a[i] == b[j] {
                            lcs[i][j] + 1
                        } else {
                            lcs[i][j + 1].max(lcs[i + 1][j])
                        };
                    }
                }
                let mut remaining = DIFF_STEPS;
                let matches = matching(a, b, &mut remaining).unwrap();
                assert_eq!(
                    matches.iter().map(|(r, _)| r.len()).sum::<usize>(),
                    lcs[a.len()][b.len()],
                    "{a:?} -> {b:?}"
                );
                for (r, start) in matches {
                    assert_eq!(a[r.clone()], b[start..start + r.len()]);
                }
            }
        }
    }

    #[test]
    fn myers_equal_ranges_are_exact_for_small_edit_pairs() {
        let inputs = ["", "a", "b", "aa", "ab", "ba", "bb", "😀a", "a😀"];
        for a in inputs {
            for b in inputs {
                let mut remaining = DIFF_STEPS;
                for (range, start) in unchanged_ranges(a, b, &mut remaining).unwrap() {
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
