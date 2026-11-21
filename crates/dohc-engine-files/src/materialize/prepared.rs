use super::{
    DurabilityPolicy, EngineStore, MAX_MATERIALIZE_BYTES, MaterializeError,
    metadata_is_reparse_point, reject_link_or_reparse, resolve_target, temp_sibling,
    walk_target_components, write_temp,
};
use dohc_engine_storage::{FileFlusher, Flushed, MaterializationJob, MaterializationOperation};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const WORKERS: usize = 64;
const BYTE_BUDGET: usize = 64 << 20;

/// Temps for ordinary writes, written and flushed many at a time before their
/// jobs run. A job that takes its temp skips writing and flushing one, so its
/// file is still on disk before it replaces the target. A job only takes the
/// file that was flushed, unchanged since. Dropping this removes every temp no
/// job took.
#[derive(Default)]
pub struct PreparedTemps {
    temps: RefCell<HashMap<String, PreparedTemp>>,
}

struct PreparedTemp {
    path: PathBuf,
    stamp: Stamp,
}

/// A file's identity, size, and the times that change when it is written.
/// On Unix that includes the change time, which no program can set.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    device: u64,
    index: u64,
    len: u64,
    times: Times,
}

#[cfg(unix)]
type Times = [i64; 4];
#[cfg(windows)]
type Times = u64;

struct Work<'a> {
    job: &'a MaterializationJob,
    target: PathBuf,
    content: Vec<u8>,
}

impl PreparedTemps {
    /// Prepare temps for the ordinary writes among `jobs`, up to a byte
    /// budget. A job left out, or whose temp fails, writes its own.
    pub fn prepare(
        store: &EngineStore,
        root: &Path,
        jobs: &[&MaterializationJob],
        policy: DurabilityPolicy,
    ) -> Self {
        let prepared = Self::default();
        if store.is_passive() {
            return prepared;
        }
        let Ok(root) = std::fs::canonicalize(root) else {
            return prepared;
        };
        let mut budget = BYTE_BUDGET;
        let work: Vec<Work<'_>> = jobs
            .iter()
            .filter_map(|&job| {
                if job.operation != MaterializationOperation::Write
                    || crate::floor::names_os_metadata(&job.target_path)
                    || crate::policy::normalized_path_is_secret(&job.target_path)
                    || !matches!(store.staging_location(&job.job_id), Ok(None))
                {
                    return None;
                }
                let target = resolve_target(&root, &job.target_path).ok()?;
                let content = store.get_materialization_blob(&job.content_sha256).ok()??;
                if content.len() > MAX_MATERIALIZE_BYTES || content.len() > budget {
                    return None;
                }
                budget -= content.len();
                Some(Work {
                    job,
                    target,
                    content,
                })
            })
            .collect();
        let flusher = policy.fsync_file.then(|| store.file_flusher());
        let next = AtomicUsize::new(0);
        let done = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..WORKERS.min(work.len()))
                .filter_map(|_| {
                    std::thread::Builder::new()
                        .spawn_scoped(scope, || {
                            let mut done = Vec::new();
                            while let Some(work) = work.get(next.fetch_add(1, Ordering::Relaxed)) {
                                done.extend(prepare_one(&root, work, flusher));
                            }
                            done
                        })
                        .ok()
                })
                .collect();
            workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap_or_default())
                .collect::<Vec<_>>()
        });
        let mut temps = prepared.temps.borrow_mut();
        for (job_id, temp, flushed) in done {
            if let Some(flushed) = flushed {
                store.record_flush(flushed);
            }
            temps.insert(job_id, temp);
        }
        drop(temps);
        prepared
    }

    /// Whether `job_id` has at `tmp` the file prepared and flushed for it,
    /// unchanged since. Any other file there is left for the job to replace.
    pub(super) fn take(&self, job_id: &str, tmp: &Path) -> bool {
        let mut temps = self.temps.borrow_mut();
        if temps.get(job_id).is_none_or(|temp| temp.path != tmp) {
            return false;
        }
        temps
            .remove(job_id)
            .is_some_and(|temp| path_stamp(tmp) == Some(temp.stamp))
    }
}

impl Drop for PreparedTemps {
    fn drop(&mut self) {
        for (_, temp) in self.temps.get_mut().drain() {
            remove_if_unchanged(&temp.path, temp.stamp);
        }
    }
}

fn prepare_one(
    root: &Path,
    work: &Work<'_>,
    flusher: Option<FileFlusher>,
) -> Option<(String, PreparedTemp, Option<Flushed>)> {
    walk_target_components(
        root,
        work.target.parent()?,
        |folder| match std::fs::symlink_metadata(folder) {
            Ok(metadata) if metadata.is_dir() && !metadata_is_reparse_point(&metadata) => Ok(()),
            _ => Err(MaterializeError::UnsafeTargetPath),
        },
    )
    .ok()?;
    reject_link_or_reparse(&work.target).ok()?;
    let path = temp_sibling(&work.target, &work.job.job_id);
    let file = write_temp(&work.target, &path, &work.content, false).ok()?;
    let flushed = flusher.map(|flusher| flusher.flush(&file)).transpose();
    let stamp = file_stamp(&file);
    drop(file);
    match (flushed, stamp) {
        (Ok(flushed), Some(stamp)) => Some((
            work.job.job_id.clone(),
            PreparedTemp { path, stamp },
            flushed,
        )),
        (_, stamp) => {
            if let Some(stamp) = stamp {
                remove_if_unchanged(&path, stamp);
            }
            None
        }
    }
}

fn remove_if_unchanged(path: &Path, stamp: Stamp) {
    if path_stamp(path) == Some(stamp) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn file_stamp(file: &File) -> Option<Stamp> {
    metadata_stamp(&file.metadata().ok()?)
}

#[cfg(unix)]
fn path_stamp(path: &Path) -> Option<Stamp> {
    metadata_stamp(&std::fs::symlink_metadata(path).ok()?)
}

#[cfg(unix)]
fn metadata_stamp(metadata: &std::fs::Metadata) -> Option<Stamp> {
    use std::os::unix::fs::MetadataExt;
    metadata.is_file().then(|| Stamp {
        device: metadata.dev(),
        index: metadata.ino(),
        len: metadata.len(),
        times: [
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ],
    })
}

#[cfg(windows)]
fn file_stamp(file: &File) -> Option<Stamp> {
    let information = winapi_util::file::information(file).ok()?;
    Some(Stamp {
        device: information.volume_serial_number(),
        index: information.file_index(),
        len: information.file_size(),
        times: information.last_write_time()?,
    })
}

#[cfg(windows)]
fn path_stamp(path: &Path) -> Option<Stamp> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    file_stamp(&file)
}
