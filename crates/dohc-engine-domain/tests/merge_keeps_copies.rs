use dohc_engine_domain::{MarkdownMergeResult, merge_markdown};
use std::collections::HashMap;

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

fn count<'a>(lines: &[&'a str]) -> HashMap<&'a str, usize> {
    let mut counts = HashMap::new();
    for line in lines {
        *counts.entry(*line).or_insert(0) += 1;
    }
    counts
}

/// The first line whose copies a clean merge lost or added: fewer in the
/// merge than both sides kept, or more than either side has, inside a stretch
/// between lines that appear once in the base, both sides and the merge, in
/// the same order.
fn lost_or_added_copy(base: &str, local: &str, remote: &str, merged: &str) -> Option<String> {
    let texts = [base, local, remote, merged].map(lines);
    let counts = texts.each_ref().map(|text| count(text));
    let once_in_three =
        |line: &str| (0..3).all(|index| counts[index].get(line).copied() == Some(1));
    if let Some(line) = texts[0]
        .iter()
        .find(|line| once_in_three(line) && counts[3].get(*line).copied() != Some(1))
    {
        return Some(format!("{line:?} should stay once"));
    }
    let mut cuts = vec![[0_usize; 4]];
    for line in &texts[0] {
        if !once_in_three(line) {
            continue;
        }
        let at: [usize; 4] = std::array::from_fn(|index| {
            texts[index]
                .iter()
                .position(|candidate| candidate == line)
                .unwrap()
        });
        let last = cuts.last().unwrap();
        if (0..4).all(|index| at[index] >= last[index]) {
            cuts.push(at.map(|position| position + 1));
        }
    }
    let mut ends: Vec<[usize; 4]> = cuts[1..]
        .iter()
        .map(|cut| cut.map(|position| position - 1))
        .collect();
    ends.push(texts.each_ref().map(Vec::len));
    for (start, end) in cuts.iter().zip(&ends) {
        let stretch: [HashMap<&str, usize>; 3] =
            std::array::from_fn(|side| count(&texts[side + 1][start[side + 1]..end[side + 1]]));
        for line in stretch.iter().flat_map(HashMap::keys) {
            let [local, remote, merged] =
                std::array::from_fn(|side| stretch[side].get(line).copied().unwrap_or(0));
            if merged < local.min(remote) || merged > local.max(remote) {
                return Some(format!(
                    "{line:?}: {merged} copies, local has {local}, remote has {remote}"
                ));
            }
        }
    }
    None
}

#[test]
fn a_divider_both_sides_kept_survives_the_merge() {
    let (base, local, remote) = ("\n\n\n---\n---", "\n\n---", "\n\n\n\n---");
    let MarkdownMergeResult::Merged(merged) = merge_markdown(base, local, remote) else {
        return;
    };
    assert_eq!(
        lost_or_added_copy(base, local, remote, &merged),
        None,
        "{merged:?}"
    );
}

#[test]
fn the_same_change_on_both_sides_lands_once() {
    assert_eq!(
        merge_markdown("x\nx\na\nb", "x\na\nb", "x\na\nB"),
        MarkdownMergeResult::Merged("x\na\nB".to_owned())
    );
}

#[test]
fn paragraphs_added_in_different_places_merge_cleanly() {
    assert_eq!(
        merge_markdown(
            "One.\n\nTwo.\n\nThree.",
            "One.\n\nLocal.\n\nTwo.\n\nThree.",
            "One.\n\nTwo.\n\nRemote.\n\nThree.",
        ),
        MarkdownMergeResult::Merged("One.\n\nLocal.\n\nTwo.\n\nRemote.\n\nThree.".to_owned())
    );
}

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

/// Markdown-like lines: half blank, some dividers, the rest distinct text.
fn markdown_line(random: &mut Random, serial: &mut usize, prefix: &str) -> String {
    *serial += 1;
    match random.below(20) {
        0..10 => String::new(),
        10..13 => "---".to_owned(),
        _ => format!("{prefix}{serial}"),
    }
}

fn one_line_edit(random: &mut Random, serial: &mut usize, base: &[String], prefix: &str) -> String {
    let mut side = base.to_vec();
    match random.below(3) {
        0 => {
            let at = random.below(side.len() + 1);
            side.insert(at, markdown_line(random, serial, prefix));
        }
        1 => {
            side.remove(random.below(side.len()));
        }
        _ => {
            let at = random.below(side.len());
            side[at] = markdown_line(random, serial, prefix);
        }
    }
    side.join("\n")
}

/// Paragraphs split by blank lines, edited by adding or removing a paragraph,
/// or rewriting a line.
fn paragraph_edits(
    random: &mut Random,
    serial: &mut usize,
    base: &[String],
    prefix: &str,
) -> String {
    let mut side = base.to_vec();
    for _ in 0..=random.below(2) {
        *serial += 1;
        match random.below(3) {
            0 => {
                let at = random.below(side.len() + 1);
                side.splice(at..at, [format!("{prefix}{serial}"), String::new()]);
            }
            1 if !side.is_empty() => {
                let at = random.below(side.len());
                side.drain(at..(at + 2).min(side.len()));
            }
            _ if !side.is_empty() => {
                let at = random.below(side.len());
                side[at] = format!("{prefix}{serial}");
            }
            _ => {}
        }
    }
    side.join("\n")
}

#[test]
fn random_merges_never_lose_or_add_a_copy() {
    let mut random = Random(4396);
    let mut serial = 0;
    let mut cases = Vec::new();
    for _ in 0..20_000 {
        let base: Vec<String> = (0..1 + random.below(10))
            .map(|_| markdown_line(&mut random, &mut serial, "p"))
            .collect();
        let local = one_line_edit(&mut random, &mut serial, &base, "l");
        let remote = one_line_edit(&mut random, &mut serial, &base, "r");
        cases.push((base.join("\n"), local, remote));
    }
    for _ in 0..20_000 {
        let mut base = Vec::new();
        for _ in 0..2 + random.below(5) {
            serial += 1;
            base.extend([format!("p{serial}"), String::new()]);
        }
        base.pop();
        let local = paragraph_edits(&mut random, &mut serial, &base, "l");
        let remote = paragraph_edits(&mut random, &mut serial, &base, "r");
        cases.push((base.join("\n"), local, remote));
    }

    let mut clean = 0;
    let mut wrong = Vec::new();
    for (base, local, remote) in &cases {
        if let MarkdownMergeResult::Merged(merged) = merge_markdown(base, local, remote) {
            clean += 1;
            if let Some(reason) = lost_or_added_copy(base, local, remote, &merged) {
                wrong.push((base, local, remote, merged, reason));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {clean} clean merges lost or added a copy; first: {:?}",
        wrong.len(),
        wrong.first()
    );
    assert!(clean > cases.len() / 2, "only {clean} merged cleanly");
}
