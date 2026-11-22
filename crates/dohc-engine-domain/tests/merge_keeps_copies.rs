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

/// The first line whose copies a clean merge lost or added. Anchors are lines
/// that appear once in the base, both sides and the merge. Along the longest
/// chain of anchors that every text keeps in the same order, between two
/// neighbouring anchors and before the first or after the last, no line may
/// have fewer copies in the merge than both sides have, or more than either
/// side has.
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
    let anchors: Vec<[isize; 4]> = texts[0]
        .iter()
        .filter(|line| once_in_three(line))
        .map(|line| {
            std::array::from_fn(|index| {
                texts[index]
                    .iter()
                    .position(|candidate| candidate == line)
                    .unwrap() as isize
            })
        })
        .collect();
    let before =
        |left: &[isize; 4], right: &[isize; 4]| (0..4).all(|index| left[index] < right[index]);
    let mut chains: Vec<Vec<[isize; 4]>> = Vec::new();
    for anchor in &anchors {
        let mut chain = chains
            .iter()
            .filter(|chain| before(chain.last().unwrap(), anchor))
            .fold(Vec::new(), |best, chain| {
                if chain.len() > best.len() {
                    chain.clone()
                } else {
                    best
                }
            });
        chain.push(*anchor);
        chains.push(chain);
    }
    let longest = chains.iter().fold(Vec::new(), |best, chain| {
        if chain.len() >= best.len() {
            chain.clone()
        } else {
            best
        }
    });
    let mut bounds = vec![[-1_isize; 4]];
    bounds.extend(longest);
    bounds.push(texts.each_ref().map(|text| text.len() as isize));
    for pair in bounds.windows(2) {
        let [start, end] = [pair[0], pair[1]];
        let stretch: [HashMap<&str, usize>; 3] = std::array::from_fn(|side| {
            let text = &texts[side + 1];
            count(&text[(start[side + 1] + 1) as usize..end[side + 1] as usize])
        });
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

