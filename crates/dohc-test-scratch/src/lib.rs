//! Run-scoped scratch directories for test harnesses.

use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

const SCRATCH_PARENT: &str = "dohc-test-scratch";
/// How long a run root must be untouched before the sweep may remove it.
///
/// This is a limit that destroys work, so it is set past the longest run this
/// repo asks for. `tools/rust-engine-program/soak-config.json` declares
/// `postCutoverContinuous.durationsHours: [6, 24]`, so a soak legitimately runs
/// for a day, holding an engine workspace open the whole time. Double the
/// longest declared soak.
const MAX_RUN_AGE: Duration = Duration::from_secs(48 * 60 * 60);
// Windows refuses to unlink a file whose handle is still open, and a just-closed
// SQLite handle (engine.db plus its -wal and -shm) can hold one for a beat after
// the store is dropped. The desktop e2e helper this replaces waited
// `100ms * attempt` over 8 attempts; halving that to 50ms cost real cleanup, and
// the gate's leak row caught it as four surviving engine.db trees.
//
// This budget does not win the race outright and cannot: the handle is released
// when the test binary exits, which is after this guard has run. Under a full
// `--workspace` run a few trees still survive, and the gate reclaims them and
// holds the count to a measured limit. See `scratch-leak-report.mjs`.
const WINDOWS_CLEANUP_ATTEMPTS: usize = 8;
const WINDOWS_CLEANUP_DELAY: Duration = Duration::from_millis(100);

static PROCESS_RUN_ID: OnceLock<String> = OnceLock::new();
static SWEEP_STARTED: OnceLock<()> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A unique directory removed when its guard drops.
#[derive(Debug)]
pub struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    /// Create a scratch directory with the default name.
    pub fn new() -> io::Result<Self> {
        Self::new_named("scratch")
    }

    /// Create a scratch directory whose name identifies its test harness.
    pub fn new_named(name: &str) -> io::Result<Self> {
        let run_root = current_run_root()?;
        sweep_once(&run_root);
        fs::create_dir_all(&run_root)?;
        let name = safe_component(name, "scratch");
        for _ in 0..16 {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nonce = RandomState::new().build_hasher().finish();
            let path = run_root.join(format!("{name}-{sequence}-{nonce:016x}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir_all(&run_root)?;
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "scratch directory collision limit is 16 attempts",
        ))
    }

    /// Return the scratch directory path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Return a path below the scratch directory.
    pub fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.path.join(path)
    }
}

impl Deref for ScratchDir {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        &self.path
    }
}

impl AsRef<Path> for ScratchDir {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        if let Err(error) = remove_tree_with_retry(&self.path) {
            eprintln!(
                "scratch cleanup failed after {} attempts for {}: {error}; the run-level scratch leak check will report this directory",
                cleanup_attempts(),
                self.path.display()
            );
        }
    }
}

/// The run root, preferring an absolute path handed down by the caller.
///
/// A runner that also inspects this tree must not re-derive it. Node's
/// `os.tmpdir()` and Rust's `std::env::temp_dir()` read different variables and
/// agree only by luck: under WSL, inherited `TEMP`/`TMP` point at a `/mnt/c`
/// path that Node returns while Rust, with `TMPDIR` unset, returns `/tmp`. The
/// tests would write one tree and the runner would count another, absent one,
/// and report it clean. `DOHC_TEST_SCRATCH_ROOT` removes the second derivation
/// so the two cannot disagree.
fn current_run_root() -> io::Result<PathBuf> {
    resolve_run_root(
        std::env::var("DOHC_TEST_SCRATCH_ROOT").ok().as_deref(),
        std::env::var("DOHC_TEST_SCRATCH_RUN").ok().as_deref(),
        &std::env::temp_dir(),
    )
}

fn resolve_run_root(root: Option<&str>, run_id: Option<&str>, temp: &Path) -> io::Result<PathBuf> {
    if let Some(root) = root.filter(|value| !value.is_empty()) {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "DOHC_TEST_SCRATCH_ROOT must be an absolute path",
            ));
        }
        return Ok(root);
    }
    let run_id = match run_id.filter(|value| !value.is_empty()) {
        Some(value) => safe_component_checked(value)?,
        None => PROCESS_RUN_ID
            .get_or_init(|| {
                format!(
                    "process-{}-{:016x}",
                    std::process::id(),
                    RandomState::new().build_hasher().finish()
                )
            })
            .clone(),
    };
    Ok(temp.join(SCRATCH_PARENT).join(run_id))
}

fn safe_component_checked(value: &str) -> io::Result<String> {
    let safe = safe_component(value, "");
    if safe.is_empty() || safe == "." || safe == ".." || safe != value {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "DOHC_TEST_SCRATCH_RUN must contain only ASCII letters, digits, periods, hyphens, or underscores",
        ));
    }
    Ok(safe)
}

fn safe_component(value: &str, fallback: &str) -> String {
    let safe: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || ".-_".contains(*character))
        .collect();
    if safe.is_empty() {
        fallback.to_owned()
    } else {
        safe
    }
}

fn sweep_once(current_run: &Path) {
    SWEEP_STARTED.get_or_init(|| {
        sweep_managed_parent(current_run, SystemTime::now());
    });
}

fn sweep_managed_parent(current_run: &Path, now: SystemTime) {
    let Some(parent) = managed_parent(current_run) else {
        return;
    };
    if let Err(error) = sweep_old_runs(parent, current_run, now) {
        eprintln!(
            "scratch sweep failed under {}: {error}; retry on the next test process",
            parent.display()
        );
    }
}

/// The parent the sweep owns, or `None` when the run root sits outside it.
///
/// `DOHC_TEST_SCRATCH_ROOT` names any absolute directory, so the run root's
/// parent is only this crate's to delete from when it is the managed parent.
/// The JS twin never derives this parent from the root for the same reason;
/// see `sweepOldTestScratch` in `apps/desktop/src/workspaces/testTemp.ts`.
fn managed_parent(current_run: &Path) -> Option<&Path> {
    current_run
        .parent()
        .filter(|parent| parent.file_name() == Some(OsStr::new(SCRATCH_PARENT)))
}

fn sweep_old_runs(parent: &Path, current_run: &Path, now: SystemTime) -> io::Result<()> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path == current_run || !entry.file_type()?.is_dir() {
            continue;
        }
        if !is_idle_since(&path, now, MAX_RUN_AGE) {
            continue;
        }
        if let Err(error) = remove_tree_with_retry(&path) {
            eprintln!(
                "scratch sweep could not remove aged run {} after {} attempts: {error}",
                path.display(),
                cleanup_attempts()
            );
        }
    }
    Ok(())
}

/// Whether nothing anywhere under `path` has been touched inside `max_age`.
///
/// The run root's own mtime is not the run's liveness. A directory's mtime
/// changes when its own entries are added or removed, not when a file deeper
/// inside is written — so a soak that spends a day writing into a workspace it
/// created in its first minute leaves the root looking untouched. Reading the
/// whole tree, and stopping at the first recent thing found, asks the question
/// the sweep actually means: is anyone still working here.
fn is_idle_since(path: &Path, now: SystemTime, max_age: Duration) -> bool {
    let Ok(metadata) = path.symlink_metadata() else {
        return false;
    };
    if let Ok(modified) = metadata.modified()
        && now.duration_since(modified).is_ok_and(|age| age <= max_age)
    {
        return false;
    }
    if !metadata.is_dir() {
        return true;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    for entry in entries {
        // An entry this process cannot read is not an entry that is idle. Every
        // other error here already keeps the run; discarding these would let the
        // sweep delete a tree whose liveness it never established.
        let Ok(entry) = entry else {
            return false;
        };
        if !is_idle_since(&entry.path(), now, max_age) {
            return false;
        }
    }
    true
}

fn cleanup_attempts() -> usize {
    if cfg!(windows) {
        WINDOWS_CLEANUP_ATTEMPTS
    } else {
        1
    }
}

fn remove_tree_with_retry(path: &Path) -> io::Result<()> {
    let attempts = cleanup_attempts();
    for attempt in 1..=attempts {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt == attempts => return Err(error),
            Err(_) => std::thread::sleep(WINDOWS_CLEANUP_DELAY * attempt as u32),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use filetime::{FileTime, set_file_mtime};

    #[test]
    fn drop_removes_the_scratch_directory() {
        let path = {
            let scratch = ScratchDir::new_named("drop-test").expect("scratch");
            let path = scratch.path().to_owned();
            fs::write(scratch.join("file.txt"), "content").expect("write fixture");
            path
        };
        assert!(
            !path.exists(),
            "dropping the guard must remove its directory"
        );
    }

    /// A failing test unwinds instead of returning, and cleanup that only runs
    /// on the success path is what filled the disk. `Drop` runs during the
    /// unwind, so the directory goes with it. The panic message below is
    /// deliberate and expected in the test log.
    #[test]
    fn a_panicking_test_still_removes_its_scratch_directory() {
        let recorded = std::sync::Arc::new(std::sync::Mutex::new(None));
        let sink = std::sync::Arc::clone(&recorded);

        let outcome = std::panic::catch_unwind(move || {
            let scratch = ScratchDir::new_named("panic-test").expect("scratch");
            *sink.lock().expect("record scratch path") = Some(scratch.path().to_owned());
            fs::write(scratch.join("file.txt"), "content").expect("write fixture");
            panic!("EXPECTED: a simulated test failure holding a live scratch directory");
        });

        assert!(outcome.is_err(), "the closure must have panicked");
        let path = recorded
            .lock()
            .expect("read scratch path")
            .clone()
            .expect("the panicking closure recorded its scratch path");
        assert!(
            !path.exists(),
            "a panicking test must still remove its scratch directory"
        );
    }

    /// The runner that inspects this tree hands the root down instead of
    /// deriving it a second time. Node's `os.tmpdir()` and Rust's
    /// `std::env::temp_dir()` disagree under WSL, and a runner that counted its
    /// own guess would report an absent tree as clean.
    #[test]
    fn an_explicit_root_wins_over_every_derived_one() {
        let handed_down = if cfg!(windows) {
            PathBuf::from(r"C:\handed\down\root")
        } else {
            PathBuf::from("/handed/down/root")
        };
        let derived_temp = Path::new(if cfg!(windows) {
            r"C:\other\temp"
        } else {
            "/other/temp"
        });

        let resolved = resolve_run_root(
            Some(&handed_down.to_string_lossy()),
            Some("ignored-run-id"),
            derived_temp,
        )
        .expect("an absolute root resolves");

        assert_eq!(
            resolved, handed_down,
            "the handed-down root must be used verbatim, never re-derived"
        );
    }

    #[test]
    fn a_relative_root_is_refused_by_name() {
        let error = resolve_run_root(Some("relative/root"), None, Path::new("/tmp"))
            .expect_err("a relative root cannot be trusted to point anywhere");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(
            error.to_string().contains("DOHC_TEST_SCRATCH_ROOT"),
            "the refusal must name the variable, got: {error}"
        );
    }

    /// A soak writes into a workspace it created in its first minute. The run
    /// root's own mtime never moves, so an mtime-of-the-root sweep would delete
    /// a live day-long run.
    #[test]
    fn sweep_keeps_a_run_whose_only_recent_write_is_deep_inside() {
        let harness = ScratchDir::new_named("deep-activity").expect("scratch");
        let parent = harness.join("runs");
        let live = parent.join("live-soak");
        let deep = live.join("workspace").join(".dohc").join("engine");
        fs::create_dir_all(&deep).expect("deep tree");
        fs::write(deep.join("engine.db"), b"live").expect("recent deep write");

        let now = SystemTime::now();
        let stale = FileTime::from_system_time(now - MAX_RUN_AGE - Duration::from_secs(60));
        // Everything except the deep file looks long abandoned.
        set_file_mtime(&live, stale).expect("age the run root");
        set_file_mtime(live.join("workspace"), stale).expect("age the workspace");
        set_file_mtime(live.join("workspace").join(".dohc"), stale).expect("age .dohc");
        set_file_mtime(&deep, stale).expect("age the engine dir");

        sweep_old_runs(&parent, &parent.join("current-run"), now).expect("sweep");

        assert!(
            live.exists(),
            "a run with recent work deep inside is live and must survive the sweep"
        );
    }

    /// `DOHC_TEST_SCRATCH_ROOT` may name any absolute directory, and the
    /// obvious reason to set it is a full `%TEMP%` — the incident this crate
    /// exists for. A root on another disk makes that disk's directory the
    /// sweep's parent, and every aged sibling there is somebody's own work.
    #[test]
    fn a_run_root_outside_the_managed_parent_sweeps_nothing() {
        let harness = ScratchDir::new_named("outside-root").expect("scratch");
        let outside = harness.join("a-developers-own-directory");
        let run_root = outside.join("my-scratch");
        let victim = outside.join("important-project");
        let victim_file = victim.join("do-not-delete.txt");
        fs::create_dir_all(&run_root).expect("handed-down root");
        fs::create_dir_all(&victim).expect("victim");
        fs::write(&victim_file, b"a year of work").expect("victim file");

        let now = SystemTime::now();
        let stale = FileTime::from_system_time(now - MAX_RUN_AGE - Duration::from_secs(60));
        set_file_mtime(&victim_file, stale).expect("age the file");
        set_file_mtime(&victim, stale).expect("age the directory");

        sweep_managed_parent(&run_root, now);

        assert!(
            victim_file.exists(),
            "a root outside {SCRATCH_PARENT} must not make its parent's siblings sweepable"
        );
    }

    /// The gate hands down `<temp>/dohc-test-scratch/rust-gate-...`, so the
    /// guard above must not stop the sweep the crate is for.
    #[test]
    fn a_run_root_under_the_managed_parent_still_sweeps() {
        let harness = ScratchDir::new_named("managed-parent").expect("scratch");
        let parent = harness.join(SCRATCH_PARENT);
        let aged = parent.join("rust-gate-1234-000000000000dead");
        let current = parent.join("rust-gate-5678-000000000000beef");
        fs::create_dir_all(&aged).expect("aged run");
        fs::create_dir_all(&current).expect("current run");

        let now = SystemTime::now();
        let stale = FileTime::from_system_time(now - MAX_RUN_AGE - Duration::from_secs(60));
        set_file_mtime(&aged, stale).expect("age the run root");

        sweep_managed_parent(&current, now);

        assert!(!aged.exists(), "a handed-down gate root must still sweep");
        assert!(
            current.exists(),
            "the current run must survive its own sweep"
        );
    }

    #[test]
    fn sweep_removes_only_aged_inactive_runs() {
        let harness = ScratchDir::new_named("sweep-test").expect("scratch");
        let parent = harness.join("runs");
        let old = parent.join("old-run");
        let live = parent.join("live-run");
        let current = parent.join("current-run");
        fs::create_dir_all(&old).expect("old run");
        fs::create_dir_all(&live).expect("live run");
        fs::create_dir_all(&current).expect("current run");

        let now = SystemTime::now();
        let old_time = FileTime::from_system_time(now - MAX_RUN_AGE - Duration::from_secs(1));
        set_file_mtime(&old, old_time).expect("age old run");

        sweep_old_runs(&parent, &current, now).expect("sweep");

        assert!(!old.exists(), "the sweep must remove an aged run");
        assert!(live.exists(), "the sweep must keep a recent run");
        assert!(current.exists(), "the sweep must keep the current run");
    }
}
