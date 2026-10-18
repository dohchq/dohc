use super::{ActorHandle, RuntimeError};
use dohc_engine_files::materialize::cleanup_staging_directory;
use dohc_engine_files::retained::{Inspection, inspect};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
const ACTIVE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
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
                            let result = match inspect(&path, &row, now, held) {
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
                                    release(&handle, &path, row, Some(source))
                                }
                                Ok(Inspection::Missing) => release(&handle, &path, row, None),
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
fn release(
    handle: &ActorHandle,
    root: &std::path::Path,
    row: dohc_engine_storage::RetainedDisplacement,
    source: Option<dohc_engine_files::retained::Release>,
) -> Result<(), RuntimeError> {
    let root = root.to_path_buf();
    let directory = root
        .join(&row.source_path)
        .parent()
        .map(std::path::Path::to_path_buf);
    handle.run_blocking(move |s, _| {
        // Serialize hold creation with the last check and unlink. Changed reads
        // still import above; only source release waits for the hold to clear.
        if dohc_engine_files::placement_is_held_in(s, &row.workspace_id, &row.target_path)? {
            return Ok(());
        }
        if let Some(source) = source
            && !source.remove().map_err(RuntimeError::Materialize)?
        {
            return Ok(());
        }
        s.release_retained(row.displacement_id)?;
        if let Some(directory) = directory {
            cleanup_staging_directory(s, &root, &directory)?;
        }
        Ok(())
    })
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
