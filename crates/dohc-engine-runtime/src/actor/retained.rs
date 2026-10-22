use super::{ActorHandle, RuntimeError};
use dohc_engine_files::materialize::{cleanup_staging_directory, stored_path};
use dohc_engine_files::retained::{
    DeleteCheck, Inspection, QUIET_PERIOD_MS, check_for_delete, inspect,
};
use dohc_engine_storage::{EngineStore, RetainedDisplacement, RetainedSummary};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
const ACTIVE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// After each refused unlink an unchanged source waits twice as long before
/// it is read and tried again, from 30 seconds up to 15 minutes.
const FIRST_RETRY: Duration = Duration::from_secs(30);
const MAX_RETRY: Duration = Duration::from_secs(15 * 60);
fn next_retry(previous: Option<Duration>) -> Duration {
    previous.map_or(FIRST_RETRY, |wait| (wait * 2).min(MAX_RETRY))
}
#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    stopped: bool,
    generation: u64,
    #[cfg(test)]
    passes: Vec<(i64, bool, Duration)>,
    #[cfg(test)]
    import_gate: Option<(std::sync::mpsc::SyncSender<()>, Arc<std::sync::Barrier>)>,
    #[cfg(test)]
    unlink_gate: Option<(std::sync::mpsc::SyncSender<()>, Arc<std::sync::Barrier>)>,
    #[cfg(test)]
    unrecorded: usize,
    #[cfg(test)]
    unrecorded_peak: usize,
    #[cfg(test)]
    joining: bool,
}
#[derive(Clone, Default)]
pub(super) struct Root(Arc<(Mutex<State>, Condvar)>);
impl Root {
    pub(super) fn set(&self, path: PathBuf) {
        let mut state = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        state.root = Some(path);
        state.generation = state.generation.wrapping_add(1);
        self.0.1.notify_all();
    }
    fn stopped(&self) -> bool {
        self.0.0.lock().unwrap_or_else(|e| e.into_inner()).stopped
    }
    #[cfg(test)]
    fn before_import(&self) {
        let gate = self.0.0.lock().unwrap().import_gate.take();
        if let Some((ready, commit)) = gate {
            ready.send(()).unwrap();
            commit.wait();
        }
    }
    /// Count `bytes` a delete read and has not recorded yet, until the
    /// returned guard drops.
    #[cfg(test)]
    fn hold_unrecorded(&self, bytes: usize) -> Unrecorded {
        let mut state = self.0.0.lock().unwrap();
        state.unrecorded += bytes;
        state.unrecorded_peak = state.unrecorded_peak.max(state.unrecorded);
        Unrecorded(self.clone(), bytes)
    }
    #[cfg(test)]
    fn before_unlink(&self) {
        let gate = self.0.0.lock().unwrap().unlink_gate.take();
        if let Some((ready, commit)) = gate {
            ready.send(()).unwrap();
            commit.wait();
        }
    }
    #[cfg(test)]
    fn record_pass(&self, cursor: i64, failed: bool, delay: Duration) {
        self.0
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .passes
            .push((cursor, failed, delay));
        self.0.1.notify_all();
    }
}
#[cfg(test)]
struct Unrecorded(Root, usize);
#[cfg(test)]
impl Drop for Unrecorded {
    fn drop(&mut self) {
        self.0
            .0
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unrecorded -= self.1;
    }
}
pub(super) struct Worker {
    root: Root,
    join: Option<JoinHandle<()>>,
}
impl Worker {
    pub(super) fn spawn(handle: ActorHandle, root: Root) -> Result<Self, RuntimeError> {
        let control = root.clone();
        let join = std::thread::Builder::new()
            .name("dohc-retained-files".into())
            .spawn(move || {
                let mut cursor = 0;
                let mut delay = Duration::ZERO;
                let mut generation = 0;
                // Each refused source's last wait and the time it may be read
                // and tried again. A restart forgets them, at one read each.
                let mut backoff: std::collections::HashMap<i64, (Duration, i64)> =
                    std::collections::HashMap::new();
                loop {
                    let (lock, cv) = &*control.0;
                    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                    while state.root.is_none() && !state.stopped {
                        state = cv.wait(state).unwrap_or_else(|e| e.into_inner());
                    }
                    let (state, _) = cv
                        .wait_timeout_while(state, delay, |s| {
                            !s.stopped && s.generation == generation
                        })
                        .unwrap_or_else(|e| e.into_inner());
                    if state.stopped {
                        break;
                    }
                    if generation != state.generation {
                        backoff.clear();
                    }
                    generation = state.generation;
                    let path = state.root.clone().expect("bound root");
                    drop(state);
                    let rows = match handle.run_blocking(move |s, _| {
                        s.retained_displacements_after(cursor)?
                            .into_iter()
                            .map(|row| {
                                Ok((
                                    dohc_engine_files::placement_is_held_in(
                                        s,
                                        &row.workspace_id,
                                        &row.target_path,
                                    )?,
                                    row,
                                ))
                            })
                            .collect::<Result<Vec<_>, RuntimeError>>()
                    }) {
                        Ok(v) => v,
                        Err(RuntimeError::ActorUnavailable) => break,
                        Err(error) => {
                            eprintln!("retained displacement listing: {error}");
                            delay = (delay.max(ACTIVE_INTERVAL) * 2).min(MAX_BACKOFF);
                            #[cfg(test)]
                            control.record_pass(cursor, true, delay);
                            continue;
                        }
                    };
                    if rows.is_empty() {
                        delay = if cursor == 0 {
                            (delay.max(ACTIVE_INTERVAL) * 2).min(MAX_BACKOFF)
                        } else {
                            ACTIVE_INTERVAL
                        };
                        cursor = 0;
                    } else {
                        delay = ACTIVE_INTERVAL;
                        cursor = rows.last().map_or(0, |(_, r)| r.displacement_id);
                        for (held, row) in rows {
                            if control.stopped() {
                                break;
                            }
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                                .min(i64::MAX as u128) as i64;
                            let id = row.displacement_id;
                            let retry_at = backoff.get(&id).map_or(0, |&(_, at)| at);
                            let database = handle.database_path();
                            let inspection = inspect(&path, database, &row, now, held, retry_at);
                            if !matches!(
                                inspection,
                                Ok(Inspection::Release(_)
                                    | Inspection::Keep
                                    | Inspection::BusyCheck { .. })
                            ) {
                                backoff.remove(&id);
                            }
                            let result = match inspection {
                                Ok(Inspection::Changed { current, bytes }) => {
                                    #[cfg(test)]
                                    control.before_import();
                                    handle.run_blocking(move |s, _| {
                                        Ok(s.record_retained_read(&row, &current, &bytes, now)?)
                                    })
                                }
                                Ok(Inspection::Oversized) => handle.run_blocking(move |s, _| {
                                    Ok(s.keep_oversized_retained(&row, now)?)
                                }),
                                Ok(Inspection::Release(source)) => {
                                    release(&handle, &path, row, Some(source)).map(|outcome| {
                                        match outcome {
                                            Released::Done => {
                                                backoff.remove(&id);
                                            }
                                            Released::Held => {}
                                            Released::Refused => {
                                                let wait =
                                                    next_retry(backoff.get(&id).map(|&(w, _)| w));
                                                let at = now.saturating_add(
                                                    wait.as_millis().min(i64::MAX as u128) as i64,
                                                );
                                                backoff.insert(id, (wait, at));
                                            }
                                        }
                                    })
                                }
                                Ok(Inspection::Missing) => {
                                    release(&handle, &path, row, None).map(|_| ())
                                }
                                Ok(Inspection::BusyCheck { unsupported }) => {
                                    handle.run_blocking(move |s, _| {
                                        Ok(s.record_retained_busy_check(&row, unsupported)?)
                                    })
                                }
                                Ok(Inspection::Keep) => Ok(()),
                                Err(e) => Err(RuntimeError::Materialize(e)),
                            };
                            if let Err(error) = result {
                                eprintln!("retained displacement maintenance: {error}");
                            }
                        }
                    }
                    #[cfg(test)]
                    control.record_pass(cursor, false, delay);
                }
            })
            .map_err(RuntimeError::ThreadSpawn)?;
        Ok(Self {
            root,
            join: Some(join),
        })
    }
    pub(super) fn stop(&mut self) {
        self.root
            .0
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stopped = true;
        self.root.0.1.notify_all();
    }
    pub(super) fn join(&mut self) {
        if let Some(j) = self.join.take() {
            #[cfg(test)]
            {
                self.root.0.0.lock().unwrap().joining = true;
                self.root.0.1.notify_all();
            }
            let _ = j.join();
        }
    }
}
/// What became of a row [`release`] was asked to release.
enum Released {
    Done,
    /// A hold on the target forbids the release for now.
    Held,
    /// The source stays: it changed, a process has it open, or its volume
    /// cannot tell.
    Refused,
}
/// Release `row` and unlink its source.
fn release(
    handle: &ActorHandle,
    root: &std::path::Path,
    row: RetainedDisplacement,
    source: Option<dohc_engine_files::retained::Release>,
) -> Result<Released, RuntimeError> {
    let root = root.to_path_buf();
    let directory = staged_directory(handle.database_path(), &root, &row);
    handle.run_blocking(move |s, _| {
        // Serialize hold creation with the last check and unlink. Changed reads
        // still import above; only source release waits for the hold to clear.
        if dohc_engine_files::placement_is_held_in(s, &row.workspace_id, &row.target_path)? {
            return Ok(Released::Held);
        }
        if let Some(source) = source
            && !source.remove().map_err(RuntimeError::Materialize)?
        {
            return Ok(Released::Refused);
        }
        s.release_retained(row.displacement_id)?;
        if let Some(directory) = directory {
            cleanup_staging_directory(s, &root, &directory)?;
        }
        Ok(Released::Done)
    })
}
/// The folder that holds `row`'s source, through the engine folder the store
/// at `database` opened through.
fn staged_directory(
    database: &std::path::Path,
    root: &std::path::Path,
    row: &RetainedDisplacement,
) -> Option<PathBuf> {
    let (_, source) = stored_path(database, root, std::path::Path::new(&row.source_path));
    source.parent().map(std::path::Path::to_path_buf)
}

/// The most candidates one [`ActorHandle::list_retained_copies`] returns.
pub const RETAINED_COPIES_LIST_LIMIT: usize = 10_000;
/// The most candidates one [`ActorHandle::delete_retained_copies`] takes.
pub const RETAINED_COPIES_DELETE_LIMIT: usize = 100;
/// How many candidates one actor turn of a delete checks and unlinks, so a
/// delete never holds the writer for long.
const DELETE_BATCH: usize = 25;

/// A retained original an explicit delete may remove, as listed: its row and
/// the row's revision, which any recorded change to its source moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedCandidate {
    pub id: i64,
    pub revision: i64,
}

/// What [`ActorHandle::delete_retained_copies`] did, and what remains.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetainedDeletion {
    pub deleted: u64,
    pub skipped: u64,
    pub failed: u64,
    pub remaining: RetainedSummary,
}

/// `row` if an explicit delete may remove its source now: it belongs to
/// `workspace_id`, only its volume blocks the sweep, it is unchanged since
/// `revision` and quiet, recovery cannot need it, and no hold covers its
/// file.
fn eligible(
    store: &EngineStore,
    workspace_id: &str,
    candidate: RetainedCandidate,
    now_ms: i64,
) -> Result<Option<RetainedDisplacement>, RuntimeError> {
    let Some(row) = store.retained_displacement(candidate.id)? else {
        return Ok(None);
    };
    let eligible = row.workspace_id == workspace_id
        && row.busy_check_unsupported
        && row.changed_at_ms == candidate.revision
        && now_ms.saturating_sub(row.changed_at_ms) >= QUIET_PERIOD_MS
        && staged_original(store, &row)?
        && !store.retained_original_needed(&row)?
        && !dohc_engine_files::placement_is_held_in(store, workspace_id, &row.target_path)?;
    Ok(eligible.then_some(row))
}

/// Whether `row` names a staged original in its job's staging folder. An
/// explicit delete removes nothing else, whatever a row says.
fn staged_original(store: &EngineStore, row: &RetainedDisplacement) -> Result<bool, RuntimeError> {
    dohc_engine_files::materialize::is_staged_original(store, &row.job_id, &row.source_path)
        .map_err(RuntimeError::Materialize)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

impl ActorHandle {
    /// How many of the workspace's retained originals the sweep can never
    /// release, because their volume cannot refuse to unlink an open file,
    /// and their logical size. Read from the rows; no file is opened.
    pub async fn retained_copies_summary(
        &self,
        workspace_id: String,
    ) -> Result<RetainedSummary, RuntimeError> {
        self.run(move |store, _| Ok(store.retained_summary(&workspace_id)?))
            .await
    }

    /// The workspace's retained originals an explicit delete may remove now,
    /// oldest first, at most [`RETAINED_COPIES_LIST_LIMIT`], and whether
    /// there are more.
    pub async fn list_retained_copies(
        &self,
        workspace_id: String,
    ) -> Result<(Vec<RetainedCandidate>, bool), RuntimeError> {
        self.run(move |store, _| {
            let now = now_ms();
            let held = store.held_paths(&workspace_id)?;
            let mut candidates = Vec::new();
            let mut after = 0;
            loop {
                let rows = store.blocked_retained_displacements(
                    &workspace_id,
                    now.saturating_sub(QUIET_PERIOD_MS),
                    after,
                    512,
                )?;
                let Some(last) = rows.last() else {
                    return Ok((candidates, false));
                };
                after = last.displacement_id;
                for row in rows {
                    if !staged_original(store, &row)?
                        || store.retained_original_needed(&row)?
                        || held.iter().any(|path| {
                            dohc_engine_files::materialize::path_is_held(path, &row.target_path)
                        })
                    {
                        continue;
                    }
                    if candidates.len() == RETAINED_COPIES_LIST_LIMIT {
                        return Ok((candidates, true));
                    }
                    candidates.push(RetainedCandidate {
                        id: row.displacement_id,
                        revision: row.changed_at_ms,
                    });
                }
            }
        })
        .await
    }

    /// Delete the sources of `candidates`, as listed, in bounded batches.
    /// Their volume cannot tell whether a process has one open, so a program
    /// that still has one open may lose what it writes next; the caller has
    /// the person's or agent's acknowledgement of that. Each source is read
    /// first: changed bytes are recorded and the source stays. A hold is
    /// checked again on the writer just before the unlink, and the row goes
    /// only after its source.
    pub async fn delete_retained_copies(
        &self,
        root: PathBuf,
        workspace_id: String,
        candidates: Vec<RetainedCandidate>,
    ) -> Result<RetainedDeletion, RuntimeError> {
        let mut outcome = RetainedDeletion::default();
        let database = self.database_path().to_path_buf();
        for batch in candidates.chunks(DELETE_BATCH) {
            let batch = batch.to_vec();
            let listed = batch.len() as u64;
            let workspace = workspace_id.clone();
            let rows = self
                .run(move |store, _| {
                    let now = now_ms();
                    let mut rows = Vec::new();
                    for candidate in batch {
                        if let Some(row) = eligible(store, &workspace, candidate, now)? {
                            rows.push(row);
                        }
                    }
                    Ok(rows)
                })
                .await?;
            outcome.skipped += listed - rows.len() as u64;
            // Each source is read off the writer. A changed one is recorded
            // before the next is read, so a batch holds at most one source's
            // bytes; a source to delete holds only its descriptor.
            let mut deletable = Vec::new();
            for row in rows {
                let (checked_root, checked_database) = (root.clone(), database.clone());
                let (row, check) = tokio::task::spawn_blocking(move || {
                    let check = check_for_delete(&checked_root, &checked_database, &row);
                    (row, check)
                })
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
                match check {
                    Ok(DeleteCheck::Skip) => outcome.skipped += 1,
                    Ok(DeleteCheck::Changed { current, bytes }) => {
                        #[cfg(test)]
                        let _unrecorded = self.retained_root.hold_unrecorded(bytes.len());
                        let recorded = self
                            .run(move |store, _| {
                                Ok(store.record_retained_read(&row, &current, &bytes, now_ms())?)
                            })
                            .await;
                        match recorded {
                            Ok(()) => outcome.skipped += 1,
                            Err(RuntimeError::ActorUnavailable) => {
                                return Err(RuntimeError::ActorUnavailable);
                            }
                            Err(error) => {
                                eprintln!("retained copy delete: {error}");
                                outcome.failed += 1;
                            }
                        }
                    }
                    Ok(check) => deletable.push((row, check)),
                    Err(error) => {
                        eprintln!("retained copy delete: {error}");
                        outcome.failed += 1;
                    }
                }
            }
            #[cfg(test)]
            self.retained_root.before_unlink();
            let (batch_root, workspace) = (root.clone(), workspace_id.clone());
            let counted = self
                .run(move |store, _| {
                    let now = now_ms();
                    let mut counted = RetainedDeletion::default();
                    for (row, check) in deletable {
                        let result = (|| -> Result<bool, RuntimeError> {
                            let candidate = RetainedCandidate {
                                id: row.displacement_id,
                                revision: row.changed_at_ms,
                            };
                            if eligible(store, &workspace, candidate, now)?.is_none() {
                                return Ok(false);
                            }
                            if let DeleteCheck::Delete(source) = check
                                && !source.remove().map_err(RuntimeError::Materialize)?
                            {
                                return Ok(false);
                            }
                            store.release_retained(row.displacement_id)?;
                            // The copy is gone either way; a folder left
                            // behind does not make its delete a failure.
                            if let Some(directory) =
                                staged_directory(store.database_path(), &batch_root, &row)
                                && let Err(error) =
                                    cleanup_staging_directory(store, &batch_root, &directory)
                            {
                                eprintln!("retained copy staging cleanup: {error}");
                            }
                            Ok(true)
                        })();
                        match result {
                            Ok(true) => counted.deleted += 1,
                            Ok(false) => counted.skipped += 1,
                            Err(error) => {
                                eprintln!("retained copy delete: {error}");
                                counted.failed += 1;
                            }
                        }
                    }
                    Ok(counted)
                })
                .await?;
            outcome.deleted += counted.deleted;
            outcome.skipped += counted.skipped;
            outcome.failed += counted.failed;
        }
        outcome.remaining = self.retained_copies_summary(workspace_id).await?;
        Ok(outcome)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
        self.join();
    }
}

#[cfg(test)]
#[path = "retained_tests.rs"]
mod tests;
