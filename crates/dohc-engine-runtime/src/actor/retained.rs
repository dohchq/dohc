use super::{ActorHandle, RuntimeError};
use dohc_engine_files::retained::{Inspection, inspect};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
#[derive(Clone, Default)]
pub(super) struct Root(Arc<Mutex<Option<PathBuf>>>);
impl Root {
    pub(super) fn set(&self, path: PathBuf) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }
}
pub(super) struct Worker {
    stop: Arc<(Mutex<bool>, Condvar)>,
    join: Option<JoinHandle<()>>,
}
impl Worker {
    pub(super) fn spawn(handle: ActorHandle, root: Root) -> Result<Self, RuntimeError> {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let wait = stop.clone();
        let join = std::thread::Builder::new()
            .name("dohc-retained-files".into())
            .spawn(move || {
                let mut cursor = 0;
                loop {
                    let (lock, cv) = &*wait;
                    let flag = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let (flag, _) = cv
                        .wait_timeout_while(flag, std::time::Duration::from_secs(1), |v| !*v)
                        .unwrap_or_else(|e| e.into_inner());
                    if *flag {
                        break;
                    }
                    drop(flag);
                    let Some(path) = root.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
                    else {
                        continue;
                    };
                    let rows = match handle
                        .run_blocking(move |s, _| Ok(s.retained_displacements_after(cursor)?))
                    {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    if rows.is_empty() {
                        cursor = 0;
                        continue;
                    }
                    cursor = rows.last().map_or(0, |r| r.displacement_id);
                    for row in rows {
                        if *wait.0.lock().unwrap_or_else(|e| e.into_inner()) {
                            break;
                        }
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(i64::MAX as u128) as i64;
                        match inspect(&path, &row, now) {
                            Ok(Inspection::Changed { current, bytes }) => {
                                if let Err(e) = handle.run_blocking(move |s, _| {
                                    Ok(s.record_retained_read(&row, &current, &bytes, now)?)
                                }) {
                                    eprintln!("retained displacement import: {e}");
                                }
                            }
                            Ok(Inspection::Release(source)) => {
                                match source.remove() {
                                    Ok(true) => {}
                                    Ok(false) => continue,
                                    Err(e) => {
                                        eprintln!("retained displacement release: {e}");
                                        continue;
                                    }
                                }
                                if let Err(e) = handle.run_blocking(move |s, _| {
                                    Ok(s.release_retained(row.displacement_id)?)
                                }) {
                                    eprintln!("retained displacement row: {e}");
                                }
                            }
                            Ok(Inspection::Missing) => {
                                let _ = handle.run_blocking(move |s, _| {
                                    Ok(s.release_retained(row.displacement_id)?)
                                });
                            }
                            Ok(Inspection::Keep) => {}
                            Err(e) => eprintln!("retained displacement inspection: {e}"),
                        }
                    }
                }
            })
            .map_err(RuntimeError::ThreadSpawn)?;
        Ok(Self {
            stop,
            join: Some(join),
        })
    }
    pub(super) fn stop(&mut self) {
        *self.stop.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.stop.1.notify_all();
    }
    pub(super) fn join(&mut self) {
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
        self.join();
    }
}
