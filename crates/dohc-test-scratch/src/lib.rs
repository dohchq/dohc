//! Run-scoped scratch directories for test harnesses.

use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

const SCRATCH_PARENT: &str = "dohc-test-scratch";
const MAX_RUN_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const WINDOWS_CLEANUP_ATTEMPTS: usize = 8;
const WINDOWS_CLEANUP_DELAY: Duration = Duration::from_millis(50);

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

fn current_run_root() -> io::Result<PathBuf> {
    let run_id = match std::env::var("DOHC_TEST_SCRATCH_RUN") {
        Ok(value) if !value.is_empty() => safe_component_checked(&value)?,
        _ => PROCESS_RUN_ID
            .get_or_init(|| {
                format!(
                    "process-{}-{:016x}",
                    std::process::id(),
                    RandomState::new().build_hasher().finish()
                )
            })
            .clone(),
    };
    Ok(std::env::temp_dir().join(SCRATCH_PARENT).join(run_id))
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
        if let Some(parent) = current_run.parent()
            && let Err(error) = sweep_old_runs(parent, current_run, SystemTime::now())
        {
            eprintln!(
                "scratch sweep failed under {}: {error}; retry on the next test process",
                parent.display()
            );
        }
    });
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
        let modified = entry.metadata()?.modified()?;
        let old_enough = now
            .duration_since(modified)
            .is_ok_and(|age| age > MAX_RUN_AGE);
        if old_enough && let Err(error) = remove_tree_with_retry(&path) {
            eprintln!(
                "scratch sweep could not remove aged run {} after {} attempts: {error}",
                path.display(),
                cleanup_attempts()
            );
        }
    }
    Ok(())
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
