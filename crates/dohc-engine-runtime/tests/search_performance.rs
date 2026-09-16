//! Manual measurements of the production preview helper. No timing assertions.

use dohc_engine_runtime::search::preview_line_matches;
use std::hint::black_box;
use std::time::Instant;

#[test]
#[ignore = "manual search preview benchmark; run without competing workloads"]
fn profiles_search_preview_first_page() {
    for (name, line_count, spacing, unicode) in [
        ("dense", 10_000, 1, false),
        ("sparse", 100_000, 100, false),
        ("unicode-mixed-newlines", 10_000, 10, true),
    ] {
        let mut text = String::new();
        for index in 0..line_count {
            text.push_str(if index % spacing == 0 {
                if unicode {
                    "😀 É NEEDLE 🚀"
                } else {
                    "needle"
                }
            } else {
                "ordinary"
            });
            text.push_str(match index % 3 {
                0 => "\r\n",
                1 => "\r",
                _ => "\n",
            });
        }
        let expected = preview_line_matches(&text, "needle", 101);
        assert_eq!(expected.len(), 101);
        assert_eq!(expected.first().expect("first hit").line, 1);
        assert_eq!(expected.last().expect("last hit").line, 100 * spacing + 1);
        for _ in 0..5 {
            black_box(preview_line_matches(black_box(&text), "needle", 101));
        }
        let mut samples_ms = Vec::new();
        for _ in 0..31 {
            let started = Instant::now();
            let hits = preview_line_matches(black_box(&text), "needle", 101);
            samples_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
            assert_eq!(hits, expected);
            black_box(hits);
        }
        let mut sorted = samples_ms.clone();
        sorted.sort_by(f64::total_cmp);
        println!(
            "SEARCH_PREVIEW_PROFILE {}",
            serde_json::json!({
                "fixture": name,
                "sourceBytes": text.len(),
                "sourceLines": line_count + 1,
                "resultLimit": 101,
                "resultCount": expected.len(),
                "lastResultLine": expected.last().expect("last hit").line,
                "samplesMs": samples_ms,
                "medianMs": sorted[15],
                "p95Ms": sorted[29],
            })
        );
    }
}
