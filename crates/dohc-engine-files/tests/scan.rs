//! Scan behavior: fixture tree → normalized listing, path-floor exclusion,
//! size-cap boundary (limit-1/limit/limit+1), the fail-closed max-files bound,
//! bounded hash concurrency (the pool cap is asserted, not trusted), and
//! between-unit cancellation leaving no partial listing.

mod common;

use common::{Scratch, sha256_hex};
use dohc_engine_files::{
    CancellationToken, OverCapPolicy, ScanBounds, ScanListing, ScanOutcome, Scanner, SkipReason,
};

fn scan(scanner: &Scanner, root: &std::path::Path) -> ScanListing {
    match scanner
        .scan(root, &CancellationToken::new())
        .expect("scan ok")
    {
        ScanOutcome::Completed(listing) => listing,
        ScanOutcome::Cancelled => panic!("unexpected cancellation"),
    }
}

fn paths(listing: &ScanListing) -> Vec<&str> {
    listing.files.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn scan_produces_sorted_normalized_listing() {
    let ws = Scratch::new();
    ws.write("notes/a.md", b"# A\n");
    ws.write("scripts/run.sh", b"#!/bin/sh\ntrue\n");
    ws.write("z.txt", b"zzz");

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan(&scanner, ws.path());

    assert_eq!(paths(&listing), ["notes/a.md", "scripts/run.sh", "z.txt"]);
    let a = &listing.files[0];
    assert_eq!(a.size, 4);
    assert_eq!(a.media_type, "text/markdown");
    assert_eq!(a.sha256, sha256_hex(b"# A\n"));
}

#[test]
fn path_floor_excludes_reserved_and_sidecars() {
    let ws = Scratch::new();
    ws.write("notes/a.md", b"# A\n");
    ws.write(".dohc/engine/engine.db", b"db");
    ws.write(".git/config", b"cfg");
    ws.write("node_modules/pkg/index.js", b"pkg");
    ws.write(".dohc-write-tmp.part", b"staging");
    ws.write("finance/ledger.sqlite", b"SQLite format 3\0"); // tracked (real db file)
    ws.write("finance/ledger.sqlite-wal", b"sidecar"); // excluded (db sidecar)
    ws.write("notes/draft-wal", b"not a sidecar"); // tracked (no db base)

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan(&scanner, ws.path());

    assert_eq!(
        paths(&listing),
        ["finance/ledger.sqlite", "notes/a.md", "notes/draft-wal"]
    );
}

#[test]
fn symlink_leaf_is_never_tracked() {
    let ws = Scratch::new();
    ws.write("notes/a.md", b"# A\n");
    let made = ws.try_symlink("notes/outside.md", "../outside-secret.md");

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan(&scanner, ws.path());

    // Whether or not the symlink could be created, it is never in the listing.
    assert_eq!(paths(&listing), ["notes/a.md"]);
    if !made {
        eprintln!(
            "note: symlink creation unavailable on this host; exclusion still holds vacuously"
        );
    }
}

#[test]
fn size_cap_boundary_limit_minus_one_limit_and_plus_one() {
    let ws = Scratch::new();
    // Cap at exactly 8 bytes (inclusive).
    let cap = 8u64;
    ws.write("under.md", b"1234567"); // 7 bytes  -> hashed
    ws.write("at.md", b"12345678"); // 8 bytes    -> hashed (inclusive cap)
    ws.write("over.md", b"123456789"); // 9 bytes  -> skipped

    let bounds = ScanBounds::builder()
        .max_file_bytes(cap)
        .over_cap(OverCapPolicy::Skip)
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let listing = scan(&scanner, ws.path());

    assert_eq!(paths(&listing), ["at.md", "under.md"]);
    assert_eq!(listing.skipped.len(), 1);
    assert_eq!(listing.skipped[0].path, "over.md");
    assert_eq!(listing.skipped[0].size, 9);
    assert_eq!(listing.skipped[0].reason, SkipReason::OverCap);
}

#[test]
fn size_cap_error_policy_fails_closed() {
    let ws = Scratch::new();
    ws.write("big.md", b"way too large");
    let bounds = ScanBounds::builder()
        .max_file_bytes(4)
        .over_cap(OverCapPolicy::Error)
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let err = scanner
        .scan(ws.path(), &CancellationToken::new())
        .expect_err("over-cap must fail closed");
    assert_eq!(err.code(), "file-too-large");
}

#[test]
fn max_files_bound_fails_closed_never_truncates() {
    let ws = Scratch::new();
    for i in 0..5 {
        ws.write(&format!("f{i}.md"), b"x");
    }
    // Exactly 3 allowed; the 4th tips it over.
    let bounds = ScanBounds::builder().max_files(3).build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let err = scanner
        .scan(ws.path(), &CancellationToken::new())
        .expect_err("too many files must fail closed");
    assert_eq!(err.code(), "too-many-files");

    // At the exact cap it succeeds (boundary inclusive).
    let ws2 = Scratch::new();
    for i in 0..3 {
        ws2.write(&format!("f{i}.md"), b"x");
    }
    let scanner3 = Scanner::new(ScanBounds::builder().max_files(3).build()).expect("scanner");
    let listing = scan(&scanner3, ws2.path());
    assert_eq!(listing.files.len(), 3);
}

#[test]
fn hash_concurrency_never_exceeds_the_pool_cap() {
    let ws = Scratch::new();
    // Many files, small pool: a naive per-file spawn would show 50-way
    // concurrency; the bounded pool must cap it at the worker count.
    let workers = 2usize;
    let n = 50;
    for i in 0..n {
        ws.write(&format!("d/f{i:03}.txt"), format!("content-{i}").as_bytes());
    }
    let bounds = ScanBounds::builder()
        .hash_workers(std::num::NonZeroUsize::new(workers).unwrap())
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let listing = scan(&scanner, ws.path());

    assert_eq!(listing.files.len(), n);
    let gauge = scanner.pool().gauge();
    assert!(
        gauge.max_concurrent() <= workers,
        "peak concurrency {} exceeded the pool cap {}",
        gauge.max_concurrent(),
        workers
    );
    assert!(gauge.max_concurrent() >= 1);
    assert_eq!(gauge.hashed(), n);
}

#[test]
fn scanner_reuses_one_pool_across_scans_within_cap() {
    let ws = Scratch::new();
    for i in 0..10 {
        ws.write(&format!("f{i}.txt"), b"data");
    }
    let workers = 3usize;
    let bounds = ScanBounds::builder()
        .hash_workers(std::num::NonZeroUsize::new(workers).unwrap())
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");

    for _ in 0..3 {
        let listing = scan(&scanner, ws.path());
        assert_eq!(listing.files.len(), 10);
    }
    // Concurrency stayed capped across all three scans on the SAME pool.
    assert!(scanner.pool().gauge().max_concurrent() <= workers);
    assert_eq!(scanner.pool().gauge().hashed(), 30);
}

#[test]
fn pre_cancelled_token_yields_no_partial_listing() {
    let ws = Scratch::new();
    for i in 0..10 {
        ws.write(&format!("f{i}.md"), b"body");
    }
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let token = CancellationToken::new();
    token.cancel();

    match scanner.scan(ws.path(), &token).expect("scan returns") {
        ScanOutcome::Cancelled => {}
        ScanOutcome::Completed(_) => panic!("cancelled scan must not produce a listing"),
    }
}

#[test]
fn invalid_root_is_typed() {
    let ws = Scratch::new();
    let missing = ws.path().join("does-not-exist");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let err = scanner
        .scan(&missing, &CancellationToken::new())
        .expect_err("missing root");
    assert_eq!(err.code(), "invalid-root");
}
