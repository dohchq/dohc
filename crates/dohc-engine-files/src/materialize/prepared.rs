use super::{
    DurabilityPolicy, EngineStore, MAX_MATERIALIZE_BYTES, TargetHash, TargetReads,
    ensure_real_directory_noting, reject_link_or_reparse, resolve_target, temp_sibling,
    walk_target_components, write_temp,
};
use dohc_engine_storage::{FileFlusher, Flushed, MaterializationJob, MaterializationOperation};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::SystemTime;

const WORKERS: usize = 64;
const BYTE_BUDGET: usize = 64 << 20;

/// Temps for ordinary writes, written and flushed many at a time before their
/// jobs run. A job that takes its temp skips writing and flushing one, so its
/// file is still on disk before it replaces the target. Dropping this removes
/// every temp no job took, and the folders made only for them.
#[derive(Default)]
pub struct PreparedTemps {
    temps: RefCell<HashMap<String, PreparedTemp>>,
}

struct PreparedTemp {
    path: PathBuf,
    stamp: Stamp,
    created: Vec<PathBuf>,
}

type Stamp = (u64, Option<SystemTime>);

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

    /// Whether `job_id` has its temp at `tmp`, as it was prepared. A temp
    /// changed since is left for the job to replace.
    pub(super) fn take(&self, job_id: &str, tmp: &Path) -> bool {
        let mut temps = self.temps.borrow_mut();
        if temps.get(job_id).is_none_or(|temp| temp.path != tmp) {
            return false;
        }
        temps
            .remove(job_id)
            .is_some_and(|temp| stamp(tmp) == Some(temp.stamp))
    }
}

impl Drop for PreparedTemps {
    fn drop(&mut self) {
        let mut created = Vec::new();
        for (_, temp) in self.temps.get_mut().drain() {
            if stamp(&temp.path) == Some(temp.stamp) {
                let _ = std::fs::remove_file(&temp.path);
            }
            created.extend(temp.created);
        }
        remove_folders(created);
    }
}

fn prepare_one(
    root: &Path,
    work: &Work<'_>,
    flusher: Option<FileFlusher>,
) -> Option<(String, PreparedTemp, Option<Flushed>)> {
    let mut created = Vec::new();
    let written = (|| {
        let parent = work.target.parent()?;
        walk_target_components(root, parent, |folder| {
            ensure_real_directory_noting(folder, &mut created)
        })
        .ok()?;
        reject_link_or_reparse(&work.target).ok()?;
        if let Ok(TargetHash::Sha(sha)) = TargetReads::default().read(&work.target)
            && sha == work.job.content_sha256
        {
            return None;
        }
        let path = temp_sibling(&work.target, &work.job.job_id);
        let file = write_temp(&work.target, &path, &work.content, false).ok()?;
        let flushed = flusher.map(|flusher| flusher.flush(&file)).transpose();
        drop(file);
        match (flushed, stamp(&path)) {
            (Ok(flushed), Some(stamp)) => Some((path, stamp, flushed)),
            _ => {
                let _ = std::fs::remove_file(&path);
                None
            }
        }
    })();
    match written {
        Some((path, stamp, flushed)) => Some((
            work.job.job_id.clone(),
            PreparedTemp {
                path,
                stamp,
                created,
            },
            flushed,
        )),
        None => {
            remove_folders(created);
            None
        }
    }
}

fn stamp(path: &Path) -> Option<Stamp> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    metadata
        .file_type()
        .is_file()
        .then(|| (metadata.len(), metadata.modified().ok()))
}

fn remove_folders(mut folders: Vec<PathBuf>) {
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.components().count()));
    for folder in folders {
        let _ = std::fs::remove_dir(folder);
    }
}
