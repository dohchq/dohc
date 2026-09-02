use dohc_engine_files::{
    CancellationToken, ManifestEntry, ScanBounds, ScanManifest, ScanOutcome, Scanner,
};
use dohc_test_scratch::ScratchDir;
use std::num::NonZeroUsize;
use std::time::Instant;

const FILE_COUNT_ENV: &str = "DOHC_SCAN_BENCH_FILES";
const WORKERS_ENV: &str = "DOHC_SCAN_BENCH_WORKERS";
const MAX_MS_ENV: &str = "DOHC_SCAN_BENCH_MAX_MS";

fn positive_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .map(|raw| {
            raw.parse::<usize>()
                .ok()
                .filter(|value| *value > 0)
                .unwrap_or_else(|| panic!("{name} must be a positive integer, received {raw}"))
        })
        .unwrap_or(fallback)
}

#[test]
#[ignore = "manual cold-scan benchmark"]
fn profiles_fresh_small_file_scan() {
    let file_count = positive_usize(FILE_COUNT_ENV, 5_000);
    let workers = positive_usize(WORKERS_ENV, 4);
    let max_ms = positive_usize(MAX_MS_ENV, usize::MAX);
    let scratch = ScratchDir::new_named("scan-performance").expect("scratch");
    let fixture = scratch.join("fixture");
    std::fs::create_dir(&fixture).expect("create fixture");
    for index in 0..file_count {
        let name = format!("note-{index:05}.md");
        std::fs::write(
            fixture.join(name),
            format!("# Note {index}\n\nbody {index}\n"),
        )
        .expect("seed file");
    }

    let bounds = ScanBounds::builder()
        .hash_workers(NonZeroUsize::new(workers).expect("positive workers"))
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let started = Instant::now();
    let outcome = scanner
        .scan(&fixture, &CancellationToken::new())
        .expect("scan");
    let elapsed = started.elapsed();
    let ScanOutcome::Completed(listing) = outcome else {
        panic!("scan unexpectedly cancelled");
    };
    assert_eq!(listing.files.len(), file_count);
    assert!(listing.failed.is_empty());
    assert!(listing.skipped.is_empty());
    let prior = ScanManifest::from_entries(listing.files.iter().map(|file| {
        (
            file.path.clone(),
            ManifestEntry {
                size: file.size,
                sha256: file.sha256.clone(),
                mtime_ms: file.mtime_ms,
            },
        )
    }));
    let hashed_before_reuse = scanner.pool().gauge().hashed();
    let reused_started = Instant::now();
    let reused = scanner
        .scan_with_prior(&fixture, &prior, &CancellationToken::new())
        .expect("reused scan");
    let reused_elapsed = reused_started.elapsed();
    let ScanOutcome::Completed(reused) = reused else {
        panic!("reused scan unexpectedly cancelled");
    };
    assert_eq!(reused.files.len(), file_count);
    assert_eq!(scanner.pool().gauge().hashed(), hashed_before_reuse);
    assert!(
        elapsed.as_millis() < max_ms as u128,
        "fresh scan took {:.3}ms, exceeding the {max_ms}ms benchmark ceiling",
        elapsed.as_secs_f64() * 1_000.0,
    );
    println!(
        "SCAN_PROFILE {{\"files\":{file_count},\"workers\":{workers},\"elapsedMs\":{:.3},\"reusedMs\":{:.3},\"maxConcurrent\":{}}}",
        elapsed.as_secs_f64() * 1_000.0,
        reused_elapsed.as_secs_f64() * 1_000.0,
        scanner.pool().gauge().max_concurrent(),
    );
}
