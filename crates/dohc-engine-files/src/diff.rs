//! Scan-generation diff ("hash-changed"): compare a prior scan generation's
//! manifest against a fresh listing to classify **added / changed / removed**.
//!
//! Change detection is by content hash and size, never mtime — "hashes, not
//! timestamps, are the source of truth" (the reference accelerator's own
//! contract, `crates/workspace-kernel/src/main.rs`). The classification
//! predicate is factored into [`diff_core`] behind a seam so the seeded-bug
//! proof (a flipped hash comparison) exercises the real machinery with only the
//! predicate mutated — the differential harness must be able to catch exactly
//! this class of bug (`EXECUTION_LOG.md` CAL-2 differential-tautology lesson).

use crate::bounds::ScanBounds;
use crate::error::FilesError;
use crate::scan::{FileEntry, ScanListing};
use std::collections::BTreeMap;

/// One entry in a prior scan generation's manifest: what a file's size and hash
/// were when it was last reconciled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub size: u64,
    pub sha256: String,
}

/// A prior scan generation as a path → (size, hash) manifest. `BTreeMap` keeps
/// iteration deterministic (`PORTING.md` §11: no `HashMap` in ordered output).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanManifest {
    entries: BTreeMap<String, ManifestEntry>,
}

impl ScanManifest {
    /// An empty manifest (the baseline before the first scan).
    pub fn empty() -> Self {
        ScanManifest {
            entries: BTreeMap::new(),
        }
    }

    /// Build a manifest from explicit (path, entry) pairs — used to reconstruct
    /// a prior scan generation from a persisted/golden manifest (e.g. the
    /// differential harness's fixture manifests). A later insert for the same
    /// path wins.
    pub fn from_entries(entries: impl IntoIterator<Item = (String, ManifestEntry)>) -> Self {
        ScanManifest {
            entries: entries.into_iter().collect(),
        }
    }

    /// Build a manifest from a completed listing (its tracked files).
    pub fn from_listing(listing: &ScanListing) -> Self {
        let entries = listing
            .files
            .iter()
            .map(|f| {
                (
                    f.path.clone(),
                    ManifestEntry {
                        size: f.size,
                        sha256: f.sha256.clone(),
                    },
                )
            })
            .collect();
        ScanManifest { entries }
    }

    /// The prior entry for a path, if tracked.
    pub fn get(&self, path: &str) -> Option<&ManifestEntry> {
        self.entries.get(path)
    }

    pub(crate) fn insert(&mut self, path: String, entry: ManifestEntry) {
        self.entries.insert(path, entry);
    }

    pub(crate) fn remove(&mut self, path: &str) {
        self.entries.remove(path);
    }

    /// Number of tracked entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the manifest is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The classified difference between a prior manifest and a current listing.
/// Each vector is sorted by path (deterministic; `LANGUAGE_SEMANTICS_MATRIX.md`
/// 3.3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanDiff {
    pub added: Vec<FileEntry>,
    pub changed: Vec<FileEntry>,
    pub removed: Vec<String>,
    /// Previously-tracked paths that are STILL on disk but now exceed the size
    /// cap (present in the current listing's `skipped` set). These must NOT be
    /// classified `removed` — the file exists; only its content is too large to
    /// re-hash. The reconcile keeps them tracked at their last-known-good
    /// content (see `reconcile.rs` and `BEHAVIOR_DELTA.md` CAL-3). A file that
    /// is truly gone from disk (absent from BOTH files and skipped) is the only
    /// thing that reaches `removed`.
    pub retained_over_cap: Vec<String>,
    /// Previously-tracked paths whose absence is not trustworthy because the
    /// path itself, or an ancestor directory, failed during this scan. Like an
    /// over-cap retain, reconcile carries the prior manifest entry forward and
    /// never emits a destructive retire.
    pub unconfirmed_removed: Vec<String>,
}

impl ScanDiff {
    /// Total number of actionable diff entries (retained is a no-op disposition,
    /// so it is excluded from the bound count).
    pub fn len(&self) -> usize {
        self.added.len() + self.changed.len() + self.removed.len()
    }

    /// Whether the diff is empty (the scan converged with the prior generation).
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.changed.is_empty()
            && self.removed.is_empty()
            && self.retained_over_cap.is_empty()
            && self.unconfirmed_removed.is_empty()
    }
}

/// Compare `prior` against `current`, bounded by `bounds.max_diff_entries`.
pub fn diff_scans(
    prior: &ScanManifest,
    current: &ScanListing,
    bounds: &ScanBounds,
) -> Result<ScanDiff, FilesError> {
    diff_core(prior, current, is_unchanged, bounds.max_diff_entries)
}

/// The real change predicate: a file is unchanged iff BOTH its size and its
/// content hash match the prior manifest. Comparing size too is a cheap guard,
/// but the hash is the authority.
fn is_unchanged(prior: &ManifestEntry, current: &FileEntry) -> bool {
    prior.size == current.size && prior.sha256 == current.sha256
}

/// The diff engine, generic over the "unchanged" predicate so a seeded-bug test
/// can flip the hash comparison and prove the differential harness catches it.
///
/// The `max_entries` cap bounds the WORKING SET during construction, not after:
/// `added + changed + removed` is checked as each entry is classified, so a
/// runaway diff fails closed with [`FilesError::DiffTooLarge`] before it
/// allocates the whole result (retained-over-cap is a no-op disposition and does
/// not count against the cap).
fn diff_core<F>(
    prior: &ScanManifest,
    current: &ScanListing,
    is_unchanged: F,
    max_entries: usize,
) -> Result<ScanDiff, FilesError>
where
    F: Fn(&ManifestEntry, &FileEntry) -> bool,
{
    let too_large = || FilesError::DiffTooLarge { cap: max_entries };

    let mut added = Vec::new();
    let mut changed = Vec::new();
    for file in &current.files {
        match prior.entries.get(&file.path) {
            Some(prior_entry) if is_unchanged(prior_entry, file) => {}
            Some(_) => changed.push(file.clone()),
            None => added.push(file.clone()),
        }
        if added.len() + changed.len() > max_entries {
            return Err(too_large());
        }
    }

    // Presence is BOTH tracked files AND the skipped (over-cap-but-present)
    // set: a path present in either still exists on disk.
    let present: BTreeMap<&str, ()> = current
        .files
        .iter()
        .map(|f| (f.path.as_str(), ()))
        .collect();
    let skipped_present: BTreeMap<&str, ()> = current
        .skipped
        .iter()
        .map(|s| (s.path.as_str(), ()))
        .collect();

    let failed_paths: Vec<&str> = current
        .failed
        .iter()
        .map(|failed| failed.path.as_str())
        .collect();

    let mut removed = Vec::new();
    let mut retained_over_cap = Vec::new();
    let mut unconfirmed_removed = Vec::new();
    for path in prior.entries.keys() {
        if present.contains_key(path.as_str()) {
            continue; // classified unchanged/changed above
        }
        if skipped_present.contains_key(path.as_str()) {
            // Still on disk, only now over the size cap → retain, never remove.
            retained_over_cap.push(path.clone());
        } else if failed_paths.iter().any(|failed| {
            failed.is_empty()
                || path == failed
                || path
                    .strip_prefix(failed)
                    .is_some_and(|remainder| remainder.starts_with('/'))
        }) {
            // A directory read failure taints every descendant; a file-level
            // failure protects that exact path. Fail safe toward retention.
            unconfirmed_removed.push(path.clone());
        } else {
            // Absent from disk entirely → removed.
            removed.push(path.clone());
            if added.len() + changed.len() + removed.len() > max_entries {
                return Err(too_large());
            }
        }
    }

    added.sort_by(|a, b| a.path.cmp(&b.path));
    changed.sort_by(|a, b| a.path.cmp(&b.path));
    removed.sort();
    retained_over_cap.sort();
    unconfirmed_removed.sort();
    Ok(ScanDiff {
        added,
        changed,
        removed,
        retained_over_cap,
        unconfirmed_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64, sha: &str) -> FileEntry {
        FileEntry {
            path: path.to_owned(),
            size,
            mtime_ms: 0,
            sha256: sha.to_owned(),
            media_type: "text/markdown",
        }
    }

    fn manifest(rows: &[(&str, u64, &str)]) -> ScanManifest {
        let entries = rows
            .iter()
            .map(|(p, s, h)| {
                (
                    (*p).to_owned(),
                    ManifestEntry {
                        size: *s,
                        sha256: (*h).to_owned(),
                    },
                )
            })
            .collect();
        ScanManifest { entries }
    }

    // A dropped hash comparison: "unchanged" decided on size alone — the exact
    // class of bug the CAL-2 lesson warns a tautological harness would miss,
    // because a same-size content edit slips through as unchanged.
    fn seeded_bug_unchanged(prior: &ManifestEntry, current: &FileEntry) -> bool {
        prior.size == current.size
    }

    #[test]
    fn diff_classifies_added_changed_removed() {
        let prior = manifest(&[
            ("same.md", 5, "hSAME"),
            ("changed.md", 7, "hOLD"),
            ("gone.md", 4, "hGONE"),
        ]);
        let current = ScanListing {
            files: vec![
                entry("same.md", 5, "hSAME"),
                entry("changed.md", 6, "hNEW"),
                entry("added.md", 3, "hADD"),
            ],
            skipped: vec![],
            failed: vec![],
        };
        let diff = diff_core(&prior, &current, is_unchanged, usize::MAX).expect("diff");
        assert_eq!(
            diff.added
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["added.md"]
        );
        assert_eq!(
            diff.changed
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["changed.md"]
        );
        assert_eq!(diff.removed, ["gone.md"]);
    }

    // SEEDED-BUG PROOF: the golden diff is what the real predicate produces; the
    // flipped predicate produces a DIFFERENT diff, so an equality assertion
    // against the golden would FAIL under the bug. This proves the differential
    // assertion is load-bearing, not tautological.
    #[test]
    fn seeded_bug_is_caught_by_the_golden() {
        // changed.md is edited in place: SAME size (5), different content hash.
        let prior = manifest(&[("same.md", 5, "hSAME"), ("changed.md", 5, "hOLD")]);
        let current = ScanListing {
            files: vec![entry("same.md", 5, "hSAME"), entry("changed.md", 5, "hNEW")],
            skipped: vec![],
            failed: vec![],
        };

        let golden = diff_core(&prior, &current, is_unchanged, usize::MAX).expect("diff");
        // Real predicate: same.md unchanged, changed.md changed (hash differs).
        assert_eq!(
            golden
                .changed
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["changed.md"]
        );
        assert!(golden.added.is_empty() && golden.removed.is_empty());

        let buggy = diff_core(&prior, &current, seeded_bug_unchanged, usize::MAX).expect("diff");
        // The size-only bug misses the same-size content edit entirely.
        assert_ne!(
            golden, buggy,
            "the golden assertion must reject the seeded bug"
        );
        assert!(
            buggy.changed.is_empty(),
            "size-only diff silently drops the content change"
        );
    }

    #[test]
    fn diff_bound_trips_when_exceeded() {
        let prior = ScanManifest::empty();
        let current = ScanListing {
            files: vec![entry("a.md", 1, "h1"), entry("b.md", 1, "h2")],
            skipped: vec![],
            failed: vec![],
        };
        let bounds = ScanBounds::builder().max_diff_entries(1).build();
        let err = diff_scans(&prior, &current, &bounds).unwrap_err();
        assert_eq!(err.code(), "diff-too-large");
    }
}
