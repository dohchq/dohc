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

fn lost_or_added_copy(base: &str, local: &str, remote: &str, merged: &str) -> Option<String> {
    let sides = [base, local, remote].map(lines);
    let readings = if merged.is_empty() {
        vec![vec![], vec![""]]
    } else {
        vec![lines(merged)]
    };
    readings
        .into_iter()
        .map(|merged| lost_or_added_line_copy([&sides[0], &sides[1], &sides[2], &merged]))
        .reduce(|first, second| first.and(second))
        .unwrap()
}

fn lost_or_added_line_copy(texts: [&[&str]; 4]) -> Option<String> {
    let counts = texts.map(count);
    if let Some(line) = counts.iter().flat_map(HashMap::keys).find(|line| {
        let [base, local, remote, merged] =
            std::array::from_fn(|index| counts[index].get(*line).copied().unwrap_or(0));
        base.max(local).max(remote) <= 1
            && (base, local, remote) != (0, 1, 1)
            && (!line.bytes().all(|byte| matches!(byte, b' ' | b'\t'))
                || (base, local, remote) == (1, 1, 1))
            && merged != if base == local { remote } else { local }
    }) {
        return Some(format!("{line:?} should follow the side that changed it"));
    }
    let anchors: Vec<[isize; 4]> = texts[0]
        .iter()
        .filter(|line| (0..4).all(|index| counts[index].get(*line).copied() == Some(1)))
        .map(|line| {
            std::array::from_fn(|index| {
                texts[index]
                    .iter()
                    .position(|candidate| candidate == line)
                    .unwrap() as isize
            })
        })
        .collect();
    let mut bounds = vec![[-1_isize; 4]];
    bounds.extend(anchors);
    bounds.push(texts.each_ref().map(|text| text.len() as isize));
    let before = |earlier: usize, later: usize| {
        (0..4).all(|index| bounds[earlier][index] < bounds[later][index])
    };
    let mut ending = vec![0_usize; bounds.len()];
    for later in 1..bounds.len() {
        ending[later] = (0..later)
            .filter(|&earlier| before(earlier, later))
            .map(|earlier| ending[earlier] + 1)
            .max()
            .unwrap();
    }
    let mut starting = vec![0_usize; bounds.len()];
    for earlier in (0..bounds.len() - 1).rev() {
        starting[earlier] = (earlier + 1..bounds.len())
            .filter(|&later| before(earlier, later))
            .map(|later| starting[later] + 1)
            .max()
            .unwrap();
    }
    let longest = starting[0];
    let on_chain = |index: usize| ending[index] + starting[index] == longest;
    for (earlier, later) in (0..bounds.len())
        .flat_map(|earlier| (earlier + 1..bounds.len()).map(move |later| (earlier, later)))
        .filter(|&(earlier, later)| {
            on_chain(earlier)
                && on_chain(later)
                && ending[later] == ending[earlier] + 1
                && before(earlier, later)
        })
    {
        let [start, end] = [bounds[earlier], bounds[later]];
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

fn move_paragraph(random: &mut Random, base: &[String]) -> String {
    let mut paragraphs: Vec<&String> = base.iter().filter(|line| !line.is_empty()).collect();
    let moved = paragraphs.remove(random.below(paragraphs.len()));
    paragraphs.insert(random.below(paragraphs.len() + 1), moved);
    paragraphs
        .iter()
        .map(|line| line.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
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
    for _ in 0..20_000 {
        let mut base = Vec::new();
        for _ in 0..3 + random.below(5) {
            serial += 1;
            base.extend([format!("p{serial}"), String::new()]);
        }
        base.pop();
        let local = move_paragraph(&mut random, &base);
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
