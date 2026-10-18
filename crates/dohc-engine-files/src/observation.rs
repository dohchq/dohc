//! Settled filesystem facts, independent of capture ownership and history.

use crate::floor;
use crate::scan::FailedPath;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};

const MAX_RING_FACTS: usize = 4096;
const MAX_RING_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedEntry {
    pub path: String,
    pub symlink: bool,
    pub size: u64,
    pub modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    pub changed: (i64, i64),
    /// The path as NTFS and APFS compare names by default, so a rename that
    /// changes only case or Unicode normalization never reads as a deletion.
    #[cfg(any(windows, target_vendor = "apple"))]
    pub key: String,
}

impl ObservedEntry {
    /// Folded keys group spellings of one name. A macOS volume can hold
    /// several, such as names that differ only in a zero-width character, and
    /// each keeps its own entry. Windows keeps one per key.
    fn order(&self, other: &Self) -> std::cmp::Ordering {
        #[cfg(windows)]
        {
            self.key().cmp(other.key())
        }
        #[cfg(not(windows))]
        {
            (self.key(), &self.path).cmp(&(other.key(), &other.path))
        }
    }

    fn key(&self) -> &str {
        #[cfg(any(windows, target_vendor = "apple"))]
        {
            &self.key
        }
        #[cfg(not(any(windows, target_vendor = "apple")))]
        {
            &self.path
        }
    }
}

/// Metadata-only listing, with no hash workers or capture queue. A walker
/// observes one root.
pub struct ObservationWalker {
    bounds: crate::ScanBounds,
    feed: ObservationFeed,
    #[cfg(target_vendor = "apple")]
    ignores_case: std::sync::OnceLock<bool>,
}

impl ObservationWalker {
    pub fn new(bounds: crate::ScanBounds, feed: ObservationFeed) -> Self {
        Self {
            bounds,
            feed,
            #[cfg(target_vendor = "apple")]
            ignores_case: std::sync::OnceLock::new(),
        }
    }

    /// Whether names compare as the volume at `root` compares them: always on
    /// Windows, on macOS where the volume ignores case, never elsewhere.
    fn folds_names(&self, root: &std::path::Path) -> bool {
        #[cfg(windows)]
        {
            let _ = root;
            true
        }
        #[cfg(target_vendor = "apple")]
        {
            if let Some(&folds) = self.ignores_case.get() {
                return folds;
            }
            match volume_ignores_case(root) {
                Some(folds) => *self.ignores_case.get_or_init(|| folds),
                // A macOS volume ignores case unless it was formatted otherwise.
                None => true,
            }
        }
        #[cfg(not(any(windows, target_vendor = "apple")))]
        {
            let _ = root;
            false
        }
    }

    pub fn observe(
        &self,
        root: &std::path::Path,
        token: &crate::CancellationToken,
    ) -> Result<bool, crate::FilesError> {
        let previous_len = self
            .feed
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .listing
            .len();
        let mut listing = Vec::with_capacity(previous_len);
        let mut failed = Vec::new();
        let mut stack = vec![(root.to_path_buf(), String::new())];
        let folds = self.folds_names(root);
        let mut entries = 0;
        while let Some((dir, relative)) = stack.pop() {
            if listing.len() + failed.len() > self.bounds.max_files {
                self.feed.resync();
                return Ok(true);
            }
            if token.is_cancelled() {
                return Ok(false);
            }
            let children = match std::fs::read_dir(&dir) {
                Ok(children) => children,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && dir != root => {
                    continue;
                }
                Err(error) if dir == root => {
                    return Err(crate::FilesError::scan_io(
                        dir.to_string_lossy().into_owned(),
                        &error,
                    ));
                }
                Err(error) => {
                    failed.push(FailedPath {
                        path: relative,
                        kind: error.kind(),
                    });
                    continue;
                }
            };
            #[cfg(any(windows, target_vendor = "apple"))]
            let relative_key = if folds {
                floor::fold_segment(&relative)
            } else {
                String::new()
            };
            for child in children {
                if token.is_cancelled() {
                    return Ok(false);
                }
                entries += 1;
                if entries > self.bounds.max_entries
                    || listing.len() + failed.len() > self.bounds.max_files
                {
                    self.feed.resync();
                    return Ok(true);
                }
                let child = match child {
                    Ok(child) => child,
                    Err(error) => {
                        failed.push(FailedPath {
                            path: relative.clone(),
                            kind: error.kind(),
                        });
                        continue;
                    }
                };
                let name = child.file_name();
                let name = name.to_string_lossy();
                let normalized = floor::normalize_segment(&name);
                if floor::segment_is_ignored(&normalized) {
                    continue;
                }
                let path = if relative.is_empty() {
                    name.into_owned()
                } else {
                    format!("{relative}/{name}")
                };
                let kind = match child.file_type() {
                    Ok(kind) => kind,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        failed.push(FailedPath {
                            path,
                            kind: error.kind(),
                        });
                        continue;
                    }
                };
                if kind.is_dir() {
                    stack.push((child.path(), path));
                    continue;
                }
                if !(kind.is_file() || kind.is_symlink()) || editor_noise(&normalized) {
                    continue;
                }
                let metadata = match child.metadata() {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        failed.push(FailedPath {
                            path,
                            kind: error.kind(),
                        });
                        continue;
                    }
                };
                #[cfg(unix)]
                let changed = {
                    use std::os::unix::fs::MetadataExt;
                    (metadata.ctime(), metadata.ctime_nsec())
                };
                listing.push(ObservedEntry {
                    #[cfg(any(windows, target_vendor = "apple"))]
                    key: if !folds {
                        path.clone()
                    } else if relative_key.is_empty() {
                        normalized
                    } else {
                        format!("{relative_key}/{normalized}")
                    },
                    path,
                    symlink: metadata.file_type().is_symlink(),
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                    #[cfg(unix)]
                    changed,
                });
            }
        }
        observe_visibility_policy(root, &mut listing, &mut failed);
        self.feed
            .publish(listing, &failed, self.bounds.max_files, folds)?;
        Ok(true)
    }
}

// The listing needs policy edits even though ordinary observation excludes .dohc.
// Read metadata for this one path without entering or following the metadata directory.
fn observe_visibility_policy(
    root: &std::path::Path,
    listing: &mut Vec<ObservedEntry>,
    failed: &mut Vec<FailedPath>,
) {
    let path = ".dohc/visibility.toml";
    let metadata = (|| {
        let parent = std::fs::symlink_metadata(root.join(".dohc"))?;
        if parent.is_dir() && !parent.file_type().is_symlink() {
            std::fs::symlink_metadata(root.join(path))
        } else {
            // A refused parent still changes the policy verdict. Never follow it.
            Ok(parent)
        }
    })();
    let metadata = match metadata {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            failed.push(FailedPath {
                path: path.to_owned(),
                kind: error.kind(),
            });
            return;
        }
    };
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime(), metadata.ctime_nsec())
    };
    listing.push(ObservedEntry {
        path: path.to_owned(),
        symlink: metadata.file_type().is_symlink(),
        size: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        changed,
        #[cfg(any(windows, target_vendor = "apple"))]
        key: path.to_owned(),
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationCursor {
    pub generation: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Appeared,
    Disappeared,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationChanges {
    pub cursor: ObservationCursor,
    pub ready: bool,
    pub resync: bool,
    pub facts: Vec<FileChange>,
}

struct Batch {
    revision: u64,
    facts: Vec<FileChange>,
    bytes: usize,
}

struct State {
    listing: Vec<ObservedEntry>,
    listing_valid: bool,
    ready: bool,
    revision: u64,
    floor: u64,
    ring: VecDeque<Batch>,
    facts: usize,
    bytes: usize,
}

/// One bounded ring and coalescing wake per workspace binding. A slow reader
/// recovers by cursor; wake revisions never enter a lossy event queue.
#[derive(Clone)]
pub struct ObservationFeed {
    generation: String,
    state: Arc<Mutex<State>>,
    wake: tokio::sync::watch::Sender<ObservationCursor>,
}

impl Default for ObservationFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl ObservationFeed {
    pub fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let generation = format!(
            "{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let (wake, _) = tokio::sync::watch::channel(ObservationCursor {
            generation: generation.clone(),
            revision: 0,
        });
        Self {
            generation,
            state: Arc::new(Mutex::new(State {
                listing: Vec::new(),
                listing_valid: false,
                ready: false,
                revision: 0,
                floor: 0,
                ring: VecDeque::new(),
                facts: 0,
                bytes: 0,
            })),
            wake,
        }
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<ObservationCursor> {
        self.wake.subscribe()
    }

    pub fn changes_since(&self, cursor: Option<&ObservationCursor>) -> ObservationChanges {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let resync = cursor.is_none_or(|c| {
            c.generation != self.generation
                || c.revision < state.floor
                || c.revision > state.revision
        });
        ObservationChanges {
            cursor: ObservationCursor {
                generation: self.generation.clone(),
                revision: state.revision,
            },
            ready: state.ready,
            resync,
            facts: if resync {
                Vec::new()
            } else {
                state
                    .ring
                    .iter()
                    .filter(|b| b.revision > cursor.expect("validated cursor").revision)
                    .flat_map(|b| b.facts.iter().cloned())
                    .collect()
            },
        }
    }

    pub fn resync(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.listing.clear();
        state.listing_valid = false;
        state.ready = true;
        state.revision += 1;
        state.floor = state.revision;
        state.ring.clear();
        state.facts = 0;
        state.bytes = 0;
        self.wake.send_replace(ObservationCursor {
            generation: self.generation.clone(),
            revision: state.revision,
        });
    }

    /// `folds` says whether `listing`'s keys fold names, so a failed path
    /// reads the same way.
    pub(crate) fn publish(
        &self,
        mut listing: Vec<ObservedEntry>,
        failed: &[FailedPath],
        cap: usize,
        folds: bool,
    ) -> Result<(), crate::FilesError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // An unreadable directory or leaf cannot prove disappearance.
        if listing.len() > cap {
            drop(state);
            self.resync();
            return Ok(());
        }
        listing.sort_unstable_by(ObservedEntry::order);
        if !failed.is_empty() {
            let observed_len = listing.len();
            let failures: BTreeSet<String> = failed
                .iter()
                .map(|f| {
                    if !folds {
                        return f.path.clone();
                    }
                    f.path
                        .split('/')
                        .map(floor::normalize_segment)
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .collect();
            for entry in &state.listing {
                if (failures.contains("")
                    || failures.contains(entry.key())
                    || entry
                        .key()
                        .match_indices('/')
                        .any(|(index, _)| failures.contains(&entry.key()[..index])))
                    && listing[..observed_len]
                        .binary_search_by(|e| e.order(entry))
                        .is_err()
                {
                    if listing.len() == cap {
                        drop(state);
                        self.resync();
                        return Ok(());
                    }
                    listing.push(entry.clone());
                }
            }
        }
        if !failed.is_empty() {
            listing.sort_unstable_by(ObservedEntry::order);
        }
        listing.dedup_by(|a, b| a.order(b).is_eq());
        let mut changes = BTreeMap::new();
        let mut bytes = 0;
        let mut overflow = false;
        let (mut old, mut new) = (0, 0);
        'diff: while state.listing_valid && (old < state.listing.len() || new < listing.len()) {
            let key = match (state.listing.get(old), listing.get(new)) {
                (Some(a), Some(b)) => a.key().min(b.key()),
                (Some(entry), None) | (None, Some(entry)) => entry.key(),
                (None, None) => break,
            };
            let before = key_group(&state.listing, &mut old, key);
            let after = key_group(&listing, &mut new, key);
            // A group a listing cannot read makes every reader list again.
            let Some(group) = key_group_changes(before, after) else {
                overflow = true;
                break 'diff;
            };
            for (entry, kind) in group {
                let path = sidecar_base(&entry.path).unwrap_or(&entry.path);
                if !changes.contains_key(path) {
                    bytes += fact_bytes(path);
                    if changes.len() == MAX_RING_FACTS || bytes > MAX_RING_BYTES {
                        overflow = true;
                        break 'diff;
                    }
                }
                if let Some(base) = sidecar_base(&entry.path) {
                    changes
                        .entry(base.to_owned())
                        .or_insert(FileChangeKind::Changed);
                } else {
                    // A database's own disappearance takes precedence over sidecars.
                    changes.insert(entry.path.clone(), kind);
                }
            }
        }
        state.listing = listing;
        let baseline = !state.listing_valid;
        state.listing_valid = true;
        state.ready = true;
        if baseline || overflow || !changes.is_empty() {
            state.revision += 1;
            if baseline || overflow {
                state.ring.clear();
                state.facts = 0;
                state.bytes = 0;
                state.floor = state.revision;
            } else if !baseline {
                let facts: Vec<_> = changes
                    .into_iter()
                    .map(|(path, kind)| FileChange { path, kind })
                    .collect();
                state.facts += facts.len();
                state.bytes += bytes;
                let revision = state.revision;
                state.ring.push_back(Batch {
                    revision,
                    facts,
                    bytes,
                });
                while state.facts > MAX_RING_FACTS || state.bytes > MAX_RING_BYTES {
                    let removed = state.ring.pop_front().expect("over budget ring");
                    state.facts -= removed.facts.len();
                    state.bytes -= removed.bytes;
                    state.floor = removed.revision;
                }
            }
            self.wake.send_replace(ObservationCursor {
                generation: self.generation.clone(),
                revision: state.revision,
            });
        }
        Ok(())
    }
}

/// Whether the volume holding `root` ignores case. The volume answers lookups
/// in its own folders, so the workspace's `.dohc` is looked up as `.DOHC`.
/// `None` while the root has no `.dohc`.
#[cfg(target_vendor = "apple")]
fn volume_ignores_case(root: &std::path::Path) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    let identity = |name: &str| {
        std::fs::symlink_metadata(root.join(name)).map(|metadata| (metadata.dev(), metadata.ino()))
    };
    let own = identity(".dohc").ok()?;
    match identity(".DOHC") {
        Ok(found) => Some(found == own),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
        Err(_) => None,
    }
}

/// The entries from `listing[*index..]` with `key`, advancing `index` past them.
fn key_group<'a>(
    listing: &'a [ObservedEntry],
    index: &mut usize,
    key: &str,
) -> &'a [ObservedEntry] {
    let start = *index;
    while listing.get(*index).is_some_and(|entry| entry.key() == key) {
        *index += 1;
    }
    &listing[start..*index]
}

/// The facts between two listings' entries for one folded key, or `None`
/// when a listing cannot tell them. While the group keeps its paths, each
/// path is compared with itself, and when one side is empty its paths
/// appeared or disappeared. When the paths change on both sides, a respell,
/// which keeps the file, reads the same as a replacement by a name the volume
/// keeps apart. Windows reports a respell's two spellings as changed.
fn key_group_changes<'a>(
    before: &'a [ObservedEntry],
    after: &'a [ObservedEntry],
) -> Option<Vec<(&'a ObservedEntry, FileChangeKind)>> {
    let same_paths = before.len() == after.len()
        && before
            .iter()
            .zip(after)
            .all(|(old, new)| old.path == new.path);
    if !same_paths && !before.is_empty() && !after.is_empty() {
        #[cfg(windows)]
        if let ([old], [new]) = (before, after) {
            return Some(vec![
                (old, FileChangeKind::Changed),
                (new, FileChangeKind::Changed),
            ]);
        }
        return None;
    }
    let mut changes = Vec::new();
    let (mut old, mut new) = (0, 0);
    loop {
        match (before.get(old), after.get(new)) {
            (Some(a), Some(b)) => {
                old += 1;
                new += 1;
                if a != b {
                    changes.push((b, FileChangeKind::Changed));
                }
            }
            (Some(a), None) => {
                old += 1;
                changes.push((a, FileChangeKind::Disappeared));
            }
            (None, Some(b)) => {
                new += 1;
                changes.push((b, FileChangeKind::Appeared));
            }
            (None, None) => return Some(changes),
        }
    }
}

// Include JSON escaping and fixed object overhead, so a read fits the smallest
// negotiated frame even for filenames containing quotes or control characters.
fn fact_bytes(path: &str) -> usize {
    64 + path
        .bytes()
        .map(|b| match b {
            b'"' | b'\\' => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum::<usize>()
}

pub(crate) fn sidecar_base(path: &str) -> Option<&str> {
    ["-wal", "-shm", "-journal"].into_iter().find_map(|suffix| {
        let base = path.get(..path.len().checked_sub(suffix.len())?)?;
        (path[path.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
            && floor::is_database_sidecar(path))
        .then_some(base)
    })
}

/// Matches editor noise on the normalized leaf only. Ancestors use the floor.
fn editor_noise(name: &str) -> bool {
    name.ends_with(".tmp")
        || name.find(".tmp.").is_some_and(|i| i + 5 < name.len())
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with('~')
        || name.len() >= 2 && name.starts_with('#') && name.ends_with('#')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CancellationToken, ScanBounds, Scanner};
    use dohc_test_scratch::ScratchDir;

    /// Whether test listings fold names, as the default volume does.
    const FOLDS: bool = cfg!(any(windows, target_vendor = "apple"));

    /// What a respell since `cursor` reports. Windows reports both
    /// spellings changed, as `on_windows` lists. macOS asks readers to list
    /// again: a listing cannot tell a respell from a replacement by a name
    /// the volume keeps apart.
    #[cfg(any(windows, target_vendor = "apple"))]
    fn assert_respelled(f: &Fixture, cursor: &ObservationCursor, on_windows: Vec<FileChange>) {
        let changes = f.observe(cursor);
        if cfg!(windows) {
            assert_eq!(changes.facts, on_windows);
        } else {
            let _ = on_windows;
            assert!(changes.resync, "{:?}", changes.facts);
        }
    }

    struct Fixture {
        root: ScratchDir,
        scanner: ObservationWalker,
        feed: ObservationFeed,
    }
    impl Fixture {
        fn new() -> Self {
            let root = ScratchDir::new_named("file-observation").unwrap();
            // A workspace root holds `.dohc`, which tells the walker how the
            // volume compares names.
            std::fs::create_dir(root.path().join(".dohc")).unwrap();
            let feed = ObservationFeed::new();
            let scanner = ObservationWalker::new(
                ScanBounds::builder().max_file_bytes(4).build(),
                feed.clone(),
            );
            scanner
                .observe(root.path(), &CancellationToken::new())
                .unwrap();
            Self {
                root,
                scanner,
                feed,
            }
        }
        fn write(&self, path: &str, text: &str) {
            let path = self.root.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        fn scan(&self, cursor: &ObservationCursor) -> Vec<FileChange> {
            self.observe(cursor).facts
        }
        fn observe(&self, cursor: &ObservationCursor) -> ObservationChanges {
            self.scanner
                .observe(self.root.path(), &CancellationToken::new())
                .unwrap();
            self.feed.changes_since(Some(cursor))
        }
        fn cursor(&self) -> ObservationCursor {
            self.feed.changes_since(None).cursor
        }
    }
    fn fact(path: &str, kind: FileChangeKind) -> FileChange {
        FileChange {
            path: path.to_owned(),
            kind,
        }
    }

    #[test]
    fn cursor_before_first_listing_requires_resync() {
        let feed = ObservationFeed::new();
        let cursor = feed.changes_since(None).cursor;
        feed.publish(Vec::new(), &[], 10, FOLDS).unwrap();
        let changes = feed.changes_since(Some(&cursor));
        assert!(changes.ready && changes.resync);
    }

    #[test]
    fn overflow_before_first_listing_is_ready_with_resync() {
        let root = ScratchDir::new_named("observation-initial-cap").unwrap();
        let feed = ObservationFeed::new();
        let walker =
            ObservationWalker::new(ScanBounds::builder().max_files(1).build(), feed.clone());
        std::fs::write(root.path().join("a.md"), "a").unwrap();
        std::fs::write(root.path().join("b.md"), "b").unwrap();
        assert!(
            walker
                .observe(root.path(), &CancellationToken::new())
                .unwrap()
        );
        let overflow = feed.changes_since(None);
        assert!(overflow.resync && overflow.ready);
        std::fs::remove_file(root.path().join("b.md")).unwrap();
        assert!(
            walker
                .observe(root.path(), &CancellationToken::new())
                .unwrap()
        );
        let baseline = feed.changes_since(Some(&overflow.cursor));
        assert!(baseline.ready && baseline.resync);
    }

    #[test]
    fn entry_cap_before_first_listing_is_ready_with_resync() {
        let root = ScratchDir::new().unwrap();
        let feed = ObservationFeed::new();
        let cursor = feed.changes_since(None).cursor;
        std::fs::create_dir(root.path().join("folder")).unwrap();
        std::fs::write(root.path().join("folder/note.md"), "a").unwrap();
        let walker =
            ObservationWalker::new(ScanBounds::builder().max_entries(1).build(), feed.clone());
        assert!(
            walker
                .observe(root.path(), &CancellationToken::new())
                .unwrap()
        );
        let changes = feed.changes_since(Some(&cursor));
        assert!(changes.ready && changes.resync && changes.facts.is_empty());
    }

    #[test]
    fn noise_named_folders_keep_their_files() {
        let f = Fixture::new();
        let cursor = f.cursor();
        f.write("x~/note.md", "a");
        f.write("v1.tmp.old/note.md", "a");
        assert_eq!(f.scan(&cursor).len(), 2);
    }

    #[test]
    fn observation_cap_resyncs_without_failing_capture() {
        let f = Fixture::new();
        f.write("a.job.conflict", "a");
        f.write("b.job.conflict", "b");
        let cursor = f.cursor();
        ObservationWalker::new(ScanBounds::builder().max_files(1).build(), f.feed.clone())
            .observe(f.root.path(), &CancellationToken::new())
            .unwrap();
        assert!(f.feed.changes_since(Some(&cursor)).resync);
        let scanner = Scanner::new(ScanBounds::builder().max_files(1).build()).unwrap();
        assert!(matches!(
            scanner
                .scan(f.root.path(), &CancellationToken::new())
                .unwrap(),
            crate::ScanOutcome::Completed(_)
        ));
    }

    #[test]
    fn first_complete_listing_after_overflow_requires_resync() {
        let f = Fixture::new();
        f.write("a.md", "a");
        f.scan(&f.cursor());
        f.write("b.md", "b");
        let walker =
            ObservationWalker::new(ScanBounds::builder().max_files(1).build(), f.feed.clone());
        walker
            .observe(f.root.path(), &CancellationToken::new())
            .unwrap();
        let overflow = f.feed.changes_since(None);
        assert!(overflow.ready && overflow.resync);
        // A full refresh at overflow can see b.md. The recovery must clear it
        // even though the bounded observer never recorded its presence.
        std::fs::remove_file(f.root.path().join("b.md")).unwrap();
        walker
            .observe(f.root.path(), &CancellationToken::new())
            .unwrap();
        let recovered = f.feed.changes_since(Some(&overflow.cursor));
        assert!(recovered.ready && recovered.resync);
        assert!(recovered.facts.is_empty());
    }

    /// The old spelling never reads as gone: the file is still there.
    #[cfg(any(windows, target_vendor = "apple"))]
    #[test]
    fn case_only_rename_never_reads_as_a_deletion() {
        let f = Fixture::new();
        f.write("note.md", "a");
        if !f.root.path().join("NOTE.md").exists() {
            eprintln!("SKIP: this volume keeps case apart");
            return;
        }
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::rename(f.root.path().join("note.md"), f.root.path().join("NOTE.md")).unwrap();
        assert_respelled(
            &f,
            &cursor,
            vec![
                fact("NOTE.md", FileChangeKind::Changed),
                fact("note.md", FileChangeKind::Changed),
            ],
        );
        assert!(f.root.path().join("note.md").exists());
    }

    /// APFS can be formatted case-sensitive. There `note.md` and `Note.md`
    /// are two files, and each reports its own edits, removal and return. A
    /// file deleted while another spelling is created reads as just that.
    /// Skips where the volume ignores case.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn case_variants_on_a_case_sensitive_volume_report_their_own_facts() {
        let f = Fixture::new();
        f.write("note.md", "a");
        f.write("Note.md", "b");
        if std::fs::read_to_string(f.root.path().join("note.md")).unwrap() != "a" {
            eprintln!("SKIP: this volume ignores case");
            return;
        }
        f.scan(&f.cursor());
        let after = |change: &dyn Fn()| {
            let cursor = f.cursor();
            change();
            f.scan(&cursor)
        };
        let remove = |path: &str| std::fs::remove_file(f.root.path().join(path)).unwrap();
        for path in ["note.md", "Note.md"] {
            let changed = after(&|| f.write(path, "longer"));
            assert_eq!(changed, vec![fact(path, FileChangeKind::Changed)]);
        }
        assert_eq!(
            after(&|| remove("Note.md")),
            vec![fact("Note.md", FileChangeKind::Disappeared)]
        );
        assert_eq!(
            after(&|| f.write("Note.md", "back")),
            vec![fact("Note.md", FileChangeKind::Appeared)]
        );
        assert_eq!(
            after(&|| remove("note.md")),
            vec![fact("note.md", FileChangeKind::Disappeared)]
        );
        // With one spelling left, a replacement must not read as a rename.
        let replaced = after(&|| {
            remove("Note.md");
            f.write("NOTE.md", "other");
        });
        assert_eq!(
            replaced,
            vec![
                fact("NOTE.md", FileChangeKind::Appeared),
                fact("Note.md", FileChangeKind::Disappeared),
            ]
        );
    }

    /// APFS keeps `a\u{200b}b.md` and `ab.md` apart, but folding drops the
    /// zero-width space, so both share a key. Each still reports its own
    /// edits.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn names_that_fold_together_keep_their_own_facts() {
        let f = Fixture::new();
        f.write("a\u{200b}b.md", "a");
        f.write("ab.md", "b");
        f.scan(&f.cursor());
        for path in ["a\u{200b}b.md", "ab.md"] {
            let cursor = f.cursor();
            f.write(path, "longer");
            assert_eq!(f.scan(&cursor), vec![fact(path, FileChangeKind::Changed)]);
        }
    }

    /// `ab.md` and `a\u{200b}b.md` share a folded key but are two files on
    /// APFS. When one is renamed by case, or a file is replaced by a distinct
    /// name with the same key, a listing cannot tell which file went where.
    /// The feed asks readers to list again rather than report a deletion or a
    /// change that did not happen. Skips where the volume keeps case apart.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_changed_group_of_names_that_fold_together_rescans() {
        let f = Fixture::new();
        f.write("a\u{200b}b.md", "a");
        f.write("ab.md", "b");
        if !f.root.path().join("AB.md").exists() {
            eprintln!("SKIP: this volume keeps case apart");
            return;
        }
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::rename(f.root.path().join("ab.md"), f.root.path().join("AB.md")).unwrap();
        let renamed = f.observe(&cursor);
        assert!(renamed.resync, "{:?}", renamed.facts);

        let f = Fixture::new();
        f.write("ab.md", "b");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::remove_file(f.root.path().join("ab.md")).unwrap();
        f.write("a\u{200b}b.md", "a");
        let replaced = f.observe(&cursor);
        assert!(replaced.resync, "{:?}", replaced.facts);
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn normalization_only_rename_never_reads_as_a_deletion() {
        let f = Fixture::new();
        f.write("caf\u{e9}.md", "a");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::rename(
            f.root.path().join("caf\u{e9}.md"),
            f.root.path().join("cafe\u{301}.md"),
        )
        .unwrap();
        let stored: Vec<_> = std::fs::read_dir(f.root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name != ".dohc")
            .collect();
        if stored != ["cafe\u{301}.md"] {
            eprintln!("SKIP: this volume kept the old spelling: {stored:?}");
            return;
        }
        assert_respelled(&f, &cursor, Vec::new());
    }

    #[cfg(any(windows, target_vendor = "apple"))]
    #[test]
    fn case_only_directory_rename_changes_both_spellings_and_sidecar_bases() {
        let f = Fixture::new();
        f.write("notes/a.md", "a");
        if !f.root.path().join("NOTES/a.md").exists() {
            eprintln!("SKIP: this volume keeps case apart");
            return;
        }
        f.write("notes/data.sqlite-wal", "wal");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::rename(f.root.path().join("notes"), f.root.path().join("NOTES")).unwrap();
        assert_respelled(
            &f,
            &cursor,
            vec![
                fact("NOTES/a.md", FileChangeKind::Changed),
                fact("NOTES/data.sqlite", FileChangeKind::Changed),
                fact("notes/a.md", FileChangeKind::Changed),
                fact("notes/data.sqlite", FileChangeKind::Changed),
            ],
        );
    }

    #[cfg(unix)]
    #[test]
    fn ctime_detects_same_size_same_mtime_write() {
        let f = Fixture::new();
        f.write("note.md", "a");
        f.scan(&f.cursor());
        let path = f.root.path().join("note.md");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let cursor = f.cursor();
        f.write("note.md", "b");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact("note.md", FileChangeKind::Changed)]
        );
    }

    #[test]
    fn observation_create_edit_delete_and_file_rename() {
        let f = Fixture::new();
        let cursor = f.cursor();
        f.write("a.md", "a");
        assert_eq!(
            f.scan(&cursor),
            vec![fact("a.md", FileChangeKind::Appeared)]
        );
        let cursor = f.cursor();
        f.write("a.md", "longer");
        assert_eq!(f.scan(&cursor), vec![fact("a.md", FileChangeKind::Changed)]);
        let cursor = f.cursor();
        std::fs::rename(f.root.path().join("a.md"), f.root.path().join("b.md")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![
                fact("a.md", FileChangeKind::Disappeared),
                fact("b.md", FileChangeKind::Appeared)
            ]
        );
        let cursor = f.cursor();
        std::fs::remove_file(f.root.path().join("b.md")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact("b.md", FileChangeKind::Disappeared)]
        );
    }

    #[test]
    fn observation_folder_rename_and_delete_expand_to_every_leaf() {
        let f = Fixture::new();
        f.write("old/a.md", "a");
        f.write("old/sub/b.md", "b");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::rename(f.root.path().join("old"), f.root.path().join("new")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![
                fact("new/a.md", FileChangeKind::Appeared),
                fact("new/sub/b.md", FileChangeKind::Appeared),
                fact("old/a.md", FileChangeKind::Disappeared),
                fact("old/sub/b.md", FileChangeKind::Disappeared)
            ]
        );
        let cursor = f.cursor();
        std::fs::remove_dir_all(f.root.path().join("new")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![
                fact("new/a.md", FileChangeKind::Disappeared),
                fact("new/sub/b.md", FileChangeKind::Disappeared)
            ]
        );
    }

    #[test]
    fn observation_wal_only_changes_and_checkpoint_fold_into_database() {
        let f = Fixture::new();
        f.write("data.sqlite3", "db");
        f.scan(&f.cursor());
        for text in ["wal", "longer wal"] {
            let cursor = f.cursor();
            f.write("data.sqlite3-wal", text);
            assert_eq!(
                f.scan(&cursor),
                vec![fact("data.sqlite3", FileChangeKind::Changed)]
            );
        }
        let cursor = f.cursor();
        std::fs::remove_file(f.root.path().join("data.sqlite3-wal")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact("data.sqlite3", FileChangeKind::Changed)]
        );
        f.write("data.sqlite3-wal", "wal");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        std::fs::remove_file(f.root.path().join("data.sqlite3")).unwrap();
        std::fs::remove_file(f.root.path().join("data.sqlite3-wal")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact("data.sqlite3", FileChangeKind::Disappeared)]
        );
    }

    #[test]
    fn observation_includes_oversized_and_conflict_files_but_ignores_editor_noise() {
        let f = Fixture::new();
        let cursor = f.cursor();
        f.write("large.bin", "over the capture cap");
        f.write("a.job.conflict", "recover");
        for path in [
            "a.tmp",
            "a.tmp.123",
            "a.swp",
            "a.swo",
            "a~",
            "#a#",
            ".DS_Store",
            "._a.md",
            "Thumbs.db",
            ".fseventsd/a",
            ".dohc/a",
            ".git/a",
            "node_modules/a",
        ] {
            f.write(path, "noise");
        }
        assert_eq!(
            f.scan(&cursor),
            vec![
                fact("a.job.conflict", FileChangeKind::Appeared),
                fact("large.bin", FileChangeKind::Appeared)
            ]
        );
        let crate::ScanOutcome::Completed(captured) =
            Scanner::new(ScanBounds::builder().max_file_bytes(4).build())
                .unwrap()
                .scan(f.root.path(), &CancellationToken::new())
                .unwrap()
        else {
            panic!("cancelled")
        };
        assert!(
            !captured
                .files
                .iter()
                .any(|entry| entry.path == "large.bin" || entry.path.ends_with(".conflict"))
        );
    }

    #[test]
    fn observation_tracks_only_visibility_policy_inside_metadata() {
        let f = Fixture::new();
        let cursor = f.cursor();
        f.write(".dohc/visibility.toml", "visible");
        f.write(".dohc/files.toml", "noise");
        f.write(".dohc/engine/engine.db-wal", "noise");
        assert_eq!(
            f.scan(&cursor),
            vec![fact(".dohc/visibility.toml", FileChangeKind::Appeared)]
        );
        let cursor = f.cursor();
        f.write(".dohc/visibility.toml", "hidden and longer");
        f.write(".dohc/engine/engine.db-wal", "more noise");
        assert_eq!(
            f.scan(&cursor),
            vec![fact(".dohc/visibility.toml", FileChangeKind::Changed)]
        );
        let cursor = f.cursor();
        std::fs::remove_file(f.root.path().join(".dohc/visibility.toml")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact(".dohc/visibility.toml", FileChangeKind::Disappeared)]
        );
    }

    #[test]
    fn observation_policy_does_not_follow_metadata_symlinks() {
        let f = Fixture::new();
        let outside = ScratchDir::new_named("observation-policy-outside").unwrap();
        std::fs::write(outside.path().join("visibility.toml"), "outside").unwrap();
        let cursor = f.cursor();
        std::fs::remove_dir(f.root.path().join(".dohc")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), f.root.path().join(".dohc")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), f.root.path().join(".dohc")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact(".dohc/visibility.toml", FileChangeKind::Appeared)]
        );
        let cursor = f.cursor();
        std::fs::write(outside.path().join("visibility.toml"), "outside changed").unwrap();
        assert!(f.scan(&cursor).is_empty());
    }

    #[test]
    fn observation_symlink_leaf_does_not_follow_target() {
        let f = Fixture::new();
        let outside = ScratchDir::new_named("observation-link-target").unwrap();
        std::fs::write(outside.path().join("secret"), "outside").unwrap();
        let cursor = f.cursor();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), f.root.path().join("link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), f.root.path().join("link")).unwrap();
        assert_eq!(
            f.scan(&cursor),
            vec![fact("link", FileChangeKind::Appeared)]
        );
    }

    #[test]
    fn observation_indeterminate_paths_retain_last_known_presence() {
        let feed = ObservationFeed::new();
        let entry = ObservedEntry {
            path: "dir/a".to_owned(),
            symlink: false,
            size: 1,
            modified: None,
            #[cfg(unix)]
            changed: (0, 0),
            #[cfg(any(windows, target_vendor = "apple"))]
            key: "dir/a".to_owned(),
        };
        feed.publish(vec![entry], &[], 200_000, FOLDS).unwrap();
        let cursor = feed.changes_since(None).cursor;
        feed.publish(
            vec![],
            &[FailedPath {
                path: "dir".to_owned(),
                kind: std::io::ErrorKind::PermissionDenied,
            }],
            200_000,
            FOLDS,
        )
        .unwrap();
        assert!(feed.changes_since(Some(&cursor)).facts.is_empty());
        feed.publish(vec![], &[], 200_000, FOLDS).unwrap();
        assert_eq!(
            feed.changes_since(Some(&cursor)).facts,
            vec![fact("dir/a", FileChangeKind::Disappeared)]
        );
    }

    #[cfg(any(windows, target_vendor = "apple"))]
    #[test]
    fn failed_case_renamed_directory_preserves_presence() {
        let f = Fixture::new();
        f.write("dir/a.md", "a");
        f.scan(&f.cursor());
        let cursor = f.cursor();
        f.feed
            .publish(
                vec![],
                &[FailedPath {
                    path: "DIR".to_owned(),
                    kind: std::io::ErrorKind::PermissionDenied,
                }],
                10,
                true,
            )
            .unwrap();
        assert!(f.feed.changes_since(Some(&cursor)).facts.is_empty());
    }

    #[test]
    fn observation_old_cursor_and_new_generation_require_resync() {
        let f = Fixture::new();
        let cursor = f.cursor();
        for i in 0..=MAX_RING_FACTS {
            f.write(&format!("file-{i}"), "a");
        }
        f.scan(&cursor);
        assert!(f.feed.changes_since(Some(&cursor)).resync);
        let current = f.cursor();
        assert!(!f.feed.changes_since(Some(&current)).resync);
        let relaunched = ObservationFeed::new();
        assert!(relaunched.changes_since(Some(&current)).resync);
    }

    #[test]
    fn observation_escaped_facts_fit_the_response_budget() {
        let feed = ObservationFeed::new();
        feed.publish(vec![], &[], 200_000, FOLDS).unwrap();
        let cursor = feed.changes_since(None).cursor;
        let listing: Vec<_> = (0..400)
            .map(|i| ObservedEntry {
                path: format!("{i}-{}", "\u{0001}\"\\".repeat(100)),
                symlink: false,
                size: 1,
                modified: None,
                #[cfg(unix)]
                changed: (0, 0),
                #[cfg(any(windows, target_vendor = "apple"))]
                key: format!("{i}-{}", "\u{0001}\"\\".repeat(100)),
            })
            .collect();
        feed.publish(listing.clone(), &[], 200_000, FOLDS).unwrap();
        let response = feed.changes_since(Some(&cursor));
        assert!(!response.resync);
        assert_eq!(response.facts.len(), 400);
        assert!(serde_json::to_vec(&response).unwrap().len() < MAX_RING_BYTES + 1024);
        let cursor = response.cursor;
        let larger = listing
            .into_iter()
            .map(|mut e| {
                e.path.push_str(&"\u{0001}".repeat(200));
                #[cfg(any(windows, target_vendor = "apple"))]
                {
                    e.key = floor::fold_segment(&e.path);
                }
                e
            })
            .collect();
        feed.publish(larger, &[], 200_000, FOLDS).unwrap();
        let response = feed.changes_since(Some(&cursor));
        assert!(response.resync);
        assert!(response.facts.is_empty());
        assert_eq!(feed.state.lock().unwrap().listing.len(), 400);
    }

    #[test]
    #[ignore = "manual 10,000-file cost measurement"]
    fn observation_large_workspace_cost() {
        let f = Fixture::new();
        for i in 0..10_000 {
            f.write(&format!("dir-{}/file-{i}.md", i / 100), "abc");
        }
        let baseline = Scanner::new(ScanBounds::default()).unwrap();
        let crate::ScanOutcome::Completed(listing) = baseline
            .scan(f.root.path(), &CancellationToken::new())
            .unwrap()
        else {
            panic!("cancelled")
        };
        let prior = crate::ScanManifest::from_entries(listing.files.into_iter().map(|e| {
            (
                e.path,
                crate::ManifestEntry {
                    size: e.size,
                    sha256: e.sha256,
                    mtime_ms: e.mtime_ms,
                },
            )
        }));
        f.scan(&f.cursor());
        let mut times = Vec::new();
        let mut baseline_times = Vec::new();
        for _ in 0..20 {
            let start = std::time::Instant::now();
            baseline
                .scan_with_prior(f.root.path(), &prior, &CancellationToken::new())
                .unwrap();
            baseline_times.push(start.elapsed());
            let start = std::time::Instant::now();
            f.scanner
                .observe(f.root.path(), &CancellationToken::new())
                .unwrap();
            times.push(start.elapsed());
        }
        times.sort();
        baseline_times.sort();
        let state = f.feed.state.lock().unwrap();
        let memory: usize = state.listing.capacity() * std::mem::size_of::<ObservedEntry>()
            + state
                .listing
                .iter()
                .map(|e| {
                    let bytes = e.path.capacity();
                    #[cfg(any(windows, target_vendor = "apple"))]
                    let bytes = bytes + e.key.capacity();
                    bytes
                })
                .sum::<usize>();
        let listing = state.listing.clone();
        drop(state);
        let start = std::time::Instant::now();
        for _ in 0..100 {
            f.feed
                .publish(listing.clone(), &[], 200_000, FOLDS)
                .unwrap();
        }
        eprintln!(
            "OBSERVATION_COST files=10000 baseline_scan_median_ms={:.3} observed_scan_median_ms={:.3} listing_clone_sort_diff_ms={:.3} listing_bytes={} bytes_per_path={:.1}",
            baseline_times[10].as_secs_f64() * 1000.0,
            times[10].as_secs_f64() * 1000.0,
            start.elapsed().as_secs_f64() * 10.0,
            memory,
            memory as f64 / 10000.0
        );
    }
}
