use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

const CAPTURE_CHECKPOINT_FRAMES: i64 = 16_384;

/// Checkpoints have their own connection and never issue domain writes.
/// PASSIVE never invokes SQLite's busy handler.
#[derive(Debug)]
pub(crate) struct Checkpoints {
    requests: Option<SyncSender<()>>,
    thread: Option<JoinHandle<()>>,
    paused: Arc<AtomicBool>,
}

impl Checkpoints {
    pub(crate) fn start(path: &Path) -> Result<Self, crate::StorageError> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(crate::StorageError::persist)?;
        conn.busy_timeout(Duration::ZERO)
            .map_err(crate::StorageError::persist)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(crate::StorageError::persist)?;
        let (requests, rx) = mpsc::sync_channel(1);
        let paused = Arc::new(AtomicBool::new(false));
        let worker_paused = Arc::clone(&paused);
        let thread = std::thread::Builder::new()
            .name("dohc-wal-checkpoint".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    // Capture postpones small checkpoints, but a large backlog
                    // still checkpoints so a long import can recycle the WAL.
                    let frames = conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
                        Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
                    });
                    if !frames.is_ok_and(|(frames, checkpointed)| {
                        frames - checkpointed
                            >= if worker_paused.load(Ordering::Acquire) {
                                CAPTURE_CHECKPOINT_FRAMES
                            } else {
                                1000
                            }
                    }) {
                        continue;
                    }
                    // One queued request covers commits during this checkpoint.
                    let _ = conn.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    });
                }
            })
            .map_err(crate::StorageError::persist)?;
        Ok(Self {
            requests: Some(requests),
            thread: Some(thread),
            paused,
        })
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::AcqRel) && !paused {
            self.request();
        }
    }

    pub(crate) fn request(&self) -> bool {
        self.requests.as_ref().is_some_and(|requests| {
            !matches!(
                requests.try_send(()),
                Err(mpsc::TrySendError::Disconnected(()))
            )
        })
    }
}
impl Drop for Checkpoints {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{EngineStore, NoFaults, StorageError, hex_sha256};
    use dohc_test_scratch::ScratchDir;
    use std::time::{Duration, Instant};

    #[test]
    fn a_pinned_reader_does_not_block_checkpoint_shutdown_or_lose_commits() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut store = EngineStore::open(&path, 1).unwrap();
        store.enable_background_checkpoints().unwrap();
        let reader = EngineStore::open_read_only(&path).unwrap();
        reader
            .read_with(|conn| conn.execute_batch("BEGIN"))
            .unwrap();
        assert_eq!(reader.table_row_count("blobs").unwrap(), 0);
        store
            .write_with(&NoFaults, |tx| {
                let mut insert = tx
                    .prepare_cached("INSERT INTO blobs VALUES(?1,?2,?3)")
                    .map_err(StorageError::persist)?;
                for n in 0..1100 {
                    let text = format!("{n:04}{}", "x".repeat(4096));
                    insert
                        .execute(rusqlite::params![
                            hex_sha256(text.as_bytes()),
                            text.len() as i64,
                            text
                        ])
                        .map_err(StorageError::persist)?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert_eq!(store.table_row_count("blobs").unwrap(), 1100);
        assert_eq!(reader.table_row_count("blobs").unwrap(), 0);
        // A passive checkpoint may leave frames pinned. Shutdown still joins.
        drop(store);
        reader
            .read_with(|conn| conn.execute_batch("ROLLBACK"))
            .unwrap();
        drop(reader);
        let mut store = EngineStore::open(&path, 2).unwrap();
        assert_eq!(store.synchronous_setting().unwrap(), 1);
        assert_eq!(store.table_row_count("blobs").unwrap(), 1100);
        store.enable_background_checkpoints().unwrap();
        // Keep this WAL above the threshold after releasing the old reader.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE blobs SET text=text", [])
                    .map_err(StorageError::persist)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            store.request_checkpoint();
            let (frames, checkpointed) = store
                .read_with(|conn| {
                    conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
                        Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
                    })
                })
                .unwrap();
            if frames >= 0 && frames == checkpointed {
                break;
            }
            assert!(Instant::now() < deadline, "checkpoint did not finish");
            std::thread::yield_now();
        }
    }

    #[test]
    fn capture_pause_leaves_wal_work_for_the_background_resume() {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        store.enable_background_checkpoints().unwrap();
        store.pause_background_checkpoints(true);
        store
            .write_with(&NoFaults, |tx| {
                let mut insert = tx
                    .prepare_cached("INSERT INTO blobs VALUES(?1,?2,?3)")
                    .map_err(StorageError::persist)?;
                for n in 0..1100 {
                    let text = format!("{n:04}{}", "x".repeat(4096));
                    insert
                        .execute(rusqlite::params![
                            hex_sha256(text.as_bytes()),
                            text.len() as i64,
                            text
                        ])
                        .map_err(StorageError::persist)?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let backlog = || {
            store
                .read_with(|conn| {
                    conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
                        Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
                    })
                })
                .unwrap()
        };
        let (frames, checkpointed) = backlog();
        assert!(frames - checkpointed >= 1000);
        store.pause_background_checkpoints(false);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let (frames, checkpointed) = backlog();
            if frames >= 0 && frames == checkpointed {
                break;
            }
            assert!(Instant::now() < deadline, "checkpoint did not resume");
            std::thread::yield_now();
        }
        assert_eq!(store.table_row_count("blobs").unwrap(), 1100);
    }
    #[test]
    fn capture_pause_checkpoints_backlogs_above_the_high_water_mark() {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        store.enable_background_checkpoints().unwrap();
        store.pause_background_checkpoints(true);
        store
            .write_with(&NoFaults, |tx| {
                let mut insert = tx
                    .prepare_cached("INSERT INTO blobs VALUES(?1,?2,?3)")
                    .map_err(StorageError::persist)?;
                for n in 0..1100 {
                    let text = format!("{n:04}{}", "x".repeat(65_536));
                    insert
                        .execute(rusqlite::params![
                            hex_sha256(text.as_bytes()),
                            text.len() as i64,
                            text
                        ])
                        .map_err(StorageError::persist)?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            store.request_checkpoint();
            let (frames, checkpointed) = store
                .read_with(|conn| {
                    conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
                        Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
                    })
                })
                .unwrap();
            if frames >= 0 {
                assert!(frames > super::CAPTURE_CHECKPOINT_FRAMES);
            }
            if frames >= 0 && frames == checkpointed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "capture backlog did not checkpoint"
            );
            std::thread::yield_now();
        }
        assert_eq!(store.table_row_count("blobs").unwrap(), 1100);
    }
}
