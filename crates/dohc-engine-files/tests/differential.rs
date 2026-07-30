//! Differential harness (CAL-3 calibration signal).
//!
//! The goldens are the retired reference accelerator's own committed fixtures
//! (`fixtures/workspace-kernel/*.json`). Note the honest scope of what each
//! field proves:
//!
//! - `size` and `sha256` are **engine-independent** ground truth — any correct
//!   implementation computes the same bytes, so agreement confirms this crate
//!   computes them correctly, but it is NOT itself a cross-engine parity check.
//!   The accelerator and its TS client are gone (the Rust daemon owns capture),
//!   so these fixtures are now a pinned independent oracle rather than one half
//!   of a two-engine comparison.
//! - The **engine-SPECIFIC** surface — media-type classification and every
//!   path-floor decision (reserved segments, nested reserved, write-temp
//!   prefix, db-sidecar keep-vs-exclude) — is where a divergence actually
//!   hides, so those are covered exhaustively here
//!   (`scan_media_types_cover_every_branch`, `floor_rules_cover_keep_and_exclude`)
//!   rather than by the two media types the JSON fixtures happen to include.
//!
//! The extended trace exercises the divergence-prone paths the CAL-2 tautology
//! lesson demands: added/changed/removed, a size-cap boundary, a path-floor
//! exclusion, a rename (remove+add), and a cancellation mid-scan leaving
//! resumable state — with every field a divergence could hide in captured in
//! the normalized state.
//!
//! The seeded-bug-catch proof lives beside the diff engine
//! (`src/diff.rs::seeded_bug_is_caught_by_the_golden`): it flips the hash
//! comparison and shows the golden equality FAILS. This file adds the
//! harness-level counterpart — a manifest whose only difference from the tree is
//! one content hash flips the plan from empty to `changed`, proving the golden
//! is sensitive to exactly the hash bit.

mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, IngestOutcome, IngestReason,
    ManifestEntry, PathClassification, ReconcileController, ReconcileRun, ScanBounds, ScanListing,
    ScanManifest, ScanOutcome, Scanner, apply_then_ack, classify_engine_file_path, diff_scans,
};
use dohc_engine_storage::NoFaults;
use serde::Deserialize;
use std::path::{Path, PathBuf};

// ---- fixture shapes (the accelerator's documented output) -------------------

#[derive(Debug, Deserialize)]
struct FxWorkspace {
    files: Vec<FxFile>,
    #[serde(default)]
    symlinks: Vec<FxSymlink>,
}

#[derive(Debug, Deserialize)]
struct FxFile {
    path: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct FxSymlink {
    path: String,
    target: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct FxMeta {
    path: String,
    size: u64,
    sha256: String,
    #[serde(rename = "mediaType")]
    media_type: String,
}

#[derive(Debug, Deserialize)]
struct ScanFixture {
    workspace: FxWorkspace,
    expected: FxScanExpected,
}

#[derive(Debug, Deserialize)]
struct FxScanExpected {
    files: Vec<FxMeta>,
}

#[derive(Debug, Deserialize)]
struct ReconcileFixture {
    workspace: FxWorkspace,
    request: FxReconcileRequest,
    expected: FxReconcileExpected,
}

#[derive(Debug, Deserialize)]
struct FxReconcileRequest {
    manifest: Vec<FxManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct FxManifestEntry {
    path: String,
    sha256: String,
    size: u64,
    #[allow(dead_code)]
    mtime: f64,
}

#[derive(Debug, Deserialize)]
struct FxReconcileExpected {
    changed: Vec<FxMeta>,
    added: Vec<FxMeta>,
    removed: Vec<String>,
}

// ---- helpers ----------------------------------------------------------------

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/workspace-kernel")
}

fn read_fixture<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let text = std::fs::read_to_string(fixture_dir().join(name))
        .unwrap_or_else(|e| panic!("read fixture {name}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse fixture {name}: {e}"))
}

fn build_workspace(ws: &Scratch, workspace: &FxWorkspace) {
    for file in &workspace.files {
        ws.write(&file.path, file.text.as_bytes());
    }
    for link in &workspace.symlinks {
        // Best-effort; the expected output already excludes symlinks, so a host
        // without symlink privilege still matches (the link is simply absent).
        let _ = ws.try_symlink(&link.path, &link.target);
    }
}

fn normalize(files: &[dohc_engine_files::FileEntry]) -> Vec<FxMeta> {
    files
        .iter()
        .map(|f| FxMeta {
            path: f.path.clone(),
            size: f.size,
            sha256: f.sha256.clone(),
            media_type: f.media_type.to_owned(),
        })
        .collect()
}

fn scan_completed(scanner: &Scanner, root: &Path) -> ScanListing {
    match scanner
        .scan(root, &CancellationToken::new())
        .expect("scan ok")
    {
        ScanOutcome::Completed(listing) => listing,
        ScanOutcome::Cancelled => panic!("unexpected cancel"),
    }
}

// ---- goldens against the accelerator fixtures -------------------------------

#[test]
fn scan_matches_kernel_golden() {
    let fixture: ScanFixture = read_fixture("scan.json");
    let ws = Scratch::new();
    build_workspace(&ws, &fixture.workspace);

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan_completed(&scanner, ws.path());

    // Byte-for-byte match against the TS/kernel-computed sizes + hashes +
    // media types.
    assert_eq!(normalize(&listing.files), fixture.expected.files);
}

#[test]
fn reconcile_matches_kernel_golden() {
    let fixture: ReconcileFixture = read_fixture("reconcile.json");
    let ws = Scratch::new();
    build_workspace(&ws, &fixture.workspace);

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan_completed(&scanner, ws.path());

    // Reconstruct the prior generation from the fixture manifest.
    let prior = ScanManifest::from_entries(fixture.request.manifest.iter().map(|m| {
        (
            m.path.clone(),
            ManifestEntry {
                size: m.size,
                sha256: m.sha256.clone(),
            },
        )
    }));

    let diff = diff_scans(&prior, &listing, scanner.bounds()).expect("diff");
    assert_eq!(normalize(&diff.changed), fixture.expected.changed);
    assert_eq!(normalize(&diff.added), fixture.expected.added);
    assert_eq!(diff.removed, fixture.expected.removed);
}

// ---- engine-specific surface: media types + floor rules ---------------------

#[test]
fn scan_media_types_cover_every_branch() {
    let cases: &[(&str, &str)] = &[
        ("a.js", "text/javascript"),
        ("a.mjs", "text/javascript"),
        ("a.cjs", "text/javascript"),
        ("a.jsx", "text/javascript"),
        ("a.ts", "application/typescript"),
        ("a.tsx", "application/typescript"),
        ("a.mts", "application/typescript"),
        ("a.cts", "application/typescript"),
        ("a.csv", "text/csv"),
        ("a.css", "text/css"),
        ("a.scss", "text/css"),
        ("a.db", "application/vnd.sqlite3"),
        ("a.sqlite", "application/vnd.sqlite3"),
        ("a.sqlite3", "application/vnd.sqlite3"),
        ("a.html", "text/html"),
        ("a.htm", "text/html"),
        ("a.jpg", "image/jpeg"),
        ("a.jpeg", "image/jpeg"),
        ("a.json", "application/json"),
        ("a.jsonl", "application/x-ndjson"),
        ("a.ndjson", "application/x-ndjson"),
        ("a.m4a", "audio/mp4"),
        ("a.md", "text/markdown"),
        ("a.markdown", "text/markdown"),
        ("a.pdf", "application/pdf"),
        ("a.png", "image/png"),
        ("a.sh", "text/plain"),
        ("a.txt", "text/plain"),
        ("noext", "application/octet-stream"),
        ("a.bin", "application/octet-stream"),
    ];
    let ws = Scratch::new();
    for (name, _) in cases {
        ws.write(name, b"x");
    }
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan_completed(&scanner, ws.path());
    let by_path: std::collections::BTreeMap<&str, &str> = listing
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.media_type))
        .collect();
    for (name, want) in cases {
        assert_eq!(
            by_path.get(*name).copied(),
            Some(*want),
            "media type for {name}"
        );
    }
}

#[test]
fn floor_rules_cover_keep_and_exclude() {
    let ws = Scratch::new();
    // Kept:
    ws.write("keep/notes.md", b"a");
    ws.write("data/store.db", b"b"); // a db FILE is tracked (only sidecars are excluded)
    ws.write("logs/app-wal", b"c"); // NOT a db sidecar (no db base) → kept
    // Excluded:
    ws.write(".dohc/engine/engine.db", b"x"); // reserved segment at root
    ws.write("a/b/.git/config", b"x"); // nested reserved
    ws.write("node_modules/p/i.js", b"x"); // reserved
    ws.write(".dohc-write-tmp.part", b"x"); // write-temp prefix
    ws.write("data/store.db-wal", b"x"); // db sidecar
    ws.write("data/store.sqlite-shm", b"x"); // db sidecar

    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan_completed(&scanner, ws.path());
    let paths: Vec<&str> = listing.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["data/store.db", "keep/notes.md", "logs/app-wal"]);
}

// ---- harness-level sensitivity (a hash flip flips the plan) -----------------

#[test]
fn golden_is_sensitive_to_the_content_hash() {
    // The tree is identical to the manifest except one file's CONTENT. If the
    // diff (or the harness) ignored the hash, the plan would be empty; because
    // it does not, the plan reports exactly that one file as changed. This is
    // the harness proving the same property the seeded-bug unit test mutates.
    let ws = Scratch::new();
    ws.write("a.md", b"same\n");
    ws.write("b.md", b"EDITED\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let listing = scan_completed(&scanner, ws.path());

    // Manifest matches a.md exactly, but records b.md's OLD hash.
    let prior = ScanManifest::from_entries([
        (
            "a.md".to_owned(),
            ManifestEntry {
                size: 5,
                sha256: common::sha256_hex(b"same\n"),
            },
        ),
        (
            "b.md".to_owned(),
            ManifestEntry {
                size: 6, // same size as "EDITED\n" — only the hash differs
                sha256: common::sha256_hex(b"before\n"),
            },
        ),
    ]);

    let diff = diff_scans(&prior, &listing, scanner.bounds()).expect("diff");
    assert!(diff.added.is_empty());
    assert!(diff.removed.is_empty());
    assert_eq!(
        diff.changed
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["b.md"],
        "a same-size content edit MUST be detected via the hash"
    );
}

// ---- extended golden trace over divergence-prone paths ----------------------

/// A normalized reconcile plan op, ordered and comparable — the NormalizedState
/// for the reconcile plan. Every field a divergence could hide in is present.
#[derive(Debug, PartialEq, Eq)]
enum NormOp {
    Ingest {
        path: String,
        size: u64,
        sha256: String,
        media_type: String,
        reason: &'static str,
    },
    Retire {
        path: String,
    },
}

struct AcceptAll;

impl CaptureSink for AcceptAll {
    fn ingest(
        &mut self,
        _path: &str,
        size: u64,
        sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        Ok(IngestOutcome::Captured {
            size,
            sha256: sha256.to_owned(),
        })
    }

    fn retire(&mut self, _path: &str) -> Result<(), CaptureError> {
        Ok(())
    }
}

fn normalize_plan(plan: &dohc_engine_files::ReconcilePlan) -> Vec<NormOp> {
    plan.ops
        .iter()
        .map(|op| match op {
            CaptureOp::Ingest {
                path,
                size,
                sha256,
                media_type,
                reason,
            } => NormOp::Ingest {
                path: path.clone(),
                size: *size,
                sha256: sha256.clone(),
                media_type: (*media_type).to_owned(),
                reason: match reason {
                    IngestReason::Added => "added",
                    IngestReason::Changed => "changed",
                },
            },
            CaptureOp::Retire { path } => NormOp::Retire { path: path.clone() },
        })
        .collect()
}

#[test]
fn extended_trace_covers_all_divergence_prone_paths() {
    let ws = Scratch::new();
    // Baseline tree: two tracked files, one path-floor-excluded file, and one
    // over-cap file that must never be tracked.
    ws.write("keep.md", b"steady\n");
    ws.write("rename-src.md", b"movable\n");
    ws.write(".dohc/engine/engine.db", b"floor-excluded");
    ws.write("huge.bin", b"0123456789"); // 10 bytes, over an 8-byte cap

    let bounds = ScanBounds::builder().max_file_bytes(8).build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let mut ctrl = ReconcileController::new();

    // --- checkpoint 1: cancellation mid-scan leaves resumable state ---------
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        ctrl.reconcile(&scanner, ws.path(), &cancelled)
            .expect("reconcile"),
        ReconcileRun::Cancelled
    ));
    assert_eq!(ctrl.generation().0, 0);
    assert!(ctrl.is_dirty());

    // --- checkpoint 2: baseline reconcile (floor + size-cap exclusions) ------
    let base = match ctrl
        .reconcile(&scanner, ws.path(), &CancellationToken::new())
        .expect("baseline")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    };
    // Only the two real tracked files are ingested; .dohc and the over-cap file
    // never appear.
    assert_eq!(
        normalize_plan(&base),
        vec![
            NormOp::Ingest {
                path: "keep.md".to_owned(),
                size: 7,
                sha256: common::sha256_hex(b"steady\n"),
                media_type: "text/markdown".to_owned(),
                reason: "added",
            },
            NormOp::Ingest {
                path: "rename-src.md".to_owned(),
                size: 8,
                sha256: common::sha256_hex(b"movable\n"),
                media_type: "text/markdown".to_owned(),
                reason: "added",
            },
        ]
    );
    apply_then_ack(&mut ctrl, &base, &mut AcceptAll, &NoFaults).expect("baseline apply/ack");

    // --- checkpoint 3: added + changed + removed + rename in one pass --------
    // (keep the edit under the 8-byte cap so it stays a "changed", not an
    // over-cap retire; the cap is exercised by huge.bin crossing it downward.)
    ws.write("keep.md", b"edited\n"); // changed, 7 bytes (≤ cap)
    ws.write("brand-new.md", b"hello\n"); // added
    ws.rename("rename-src.md", "rename-dst.md"); // rename = retire + add
    // Shrink huge.bin under the cap so it now enters as "added" (boundary
    // crossing from over-cap to tracked).
    ws.write("huge.bin", b"small"); // 5 bytes, now tracked

    let delta = match ctrl
        .reconcile(&scanner, ws.path(), &CancellationToken::new())
        .expect("delta")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    };

    assert_eq!(
        normalize_plan(&delta),
        vec![
            NormOp::Ingest {
                path: "brand-new.md".to_owned(),
                size: 6,
                sha256: common::sha256_hex(b"hello\n"),
                media_type: "text/markdown".to_owned(),
                reason: "added",
            },
            NormOp::Ingest {
                path: "huge.bin".to_owned(),
                size: 5,
                sha256: common::sha256_hex(b"small"),
                media_type: "application/octet-stream".to_owned(),
                reason: "added",
            },
            NormOp::Ingest {
                path: "keep.md".to_owned(),
                size: 7,
                sha256: common::sha256_hex(b"edited\n"),
                media_type: "text/markdown".to_owned(),
                reason: "changed",
            },
            NormOp::Ingest {
                path: "rename-dst.md".to_owned(),
                size: 8,
                sha256: common::sha256_hex(b"movable\n"),
                media_type: "text/markdown".to_owned(),
                reason: "added",
            },
            NormOp::Retire {
                path: "rename-src.md".to_owned(),
            },
        ]
    );
    assert_eq!(delta.from_generation.0, 1);
    assert_eq!(delta.to_generation.0, 2);
}

#[test]
fn policy_classifier_matches_the_ts_secret_floor_fixture() {
    let cases = [
        ("notes/today.md", PathClassification::Tracked),
        (".env", PathClassification::Secret),
        ("config/.env.production", PathClassification::Secret),
        ("secrets%252eenv", PathClassification::Secret),
        ("secret.env ", PathClassification::Secret),
        (".dohc/engine/engine.db", PathClassification::Ignored),
        ("notes/DOHC~1/x.md", PathClassification::Ignored),
        ("../escape.md", PathClassification::Ignored),
    ];
    for (path, expected) in cases {
        assert_eq!(classify_engine_file_path(path), expected, "{path}");
    }
}
