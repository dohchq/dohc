//! Observations refused by capture. These rows confer no recorded-edit credit.
use crate::{EngineStore, StorageError};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub const NOT_REPRESENTABLE: &str = "ydoc-resolution-not-representable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureFileHold {
    pub workspace_id: String,
    pub source_version_id: String,
    pub object_id: String,
    pub path: String,
    pub observed_sha256: String,
    pub observed_size: u64,
    pub reason: String,
    pub observed_at_ms: i64,
    pub attempt_count: i64,
    pub retry_requested: bool,
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureFileHold> {
    Ok(CaptureFileHold {
        workspace_id: r.get(0)?,
        source_version_id: r.get(1)?,
        object_id: r.get(2)?,
        path: r.get(3)?,
        observed_sha256: r.get(4)?,
        observed_size: u64::try_from(r.get::<_, i64>(5)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        reason: r.get(6)?,
        observed_at_ms: r.get(7)?,
        attempt_count: r.get(8)?,
        retry_requested: r.get(9)?,
    })
}

pub fn hold_in(
    conn: &Connection,
    workspace: &str,
    path: &str,
) -> Result<Option<CaptureFileHold>, StorageError> {
    conn.prepare_cached("SELECT workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested FROM capture_file_holds WHERE workspace_id=?1 AND path=?2")
    .map_err(StorageError::corrupt_public)?
    .query_row(
        [workspace, path],
        row,
    )
    .optional()
    .map_err(StorageError::corrupt_public)
}

pub fn list_in(conn: &Connection, workspace: &str) -> Result<Vec<CaptureFileHold>, StorageError> {
    let mut q = conn
        .prepare_cached("SELECT workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested FROM capture_file_holds WHERE workspace_id=?1 ORDER BY path")
        .map_err(StorageError::corrupt_public)?;
    q.query_map([workspace], row)
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt_public)
}

/// Coordinates remain pinned even when a later observation requests another version.
pub fn record_in(tx: &Transaction<'_>, hold: &CaptureFileHold) -> Result<(), StorageError> {
    let size = i64::try_from(hold.observed_size).map_err(StorageError::persist_public)?;
    tx.execute("INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,0) ON CONFLICT(workspace_id,path) DO UPDATE SET observed_sha256=excluded.observed_sha256,observed_size=excluded.observed_size,observed_at_ms=excluded.observed_at_ms,attempt_count=capture_file_holds.attempt_count+1,retry_requested=0", params![hold.workspace_id,hold.source_version_id,hold.object_id,hold.path,hold.observed_sha256,size,hold.reason,hold.observed_at_ms]).map_err(StorageError::persist_public)?;
    Ok(())
}

pub fn clear_in(tx: &Transaction<'_>, workspace: &str, path: &str) -> Result<(), StorageError> {
    tx.execute(
        "DELETE FROM capture_file_holds WHERE workspace_id=?1 AND path=?2",
        [workspace, path],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

pub fn request_retry_in(
    tx: &Transaction<'_>,
    workspace: &str,
    path: &str,
) -> Result<bool, StorageError> {
    tx.execute(
        "UPDATE capture_file_holds SET retry_requested=1 WHERE workspace_id=?1 AND path=?2",
        [workspace, path],
    )
    .map(|n| n > 0)
    .map_err(StorageError::persist_public)
}

impl EngineStore {
    /// The paths capture holds in `workspace`. Empty workspace is the legacy
    /// placement sentinel and lists every hold, so it must also park.
    /// `dohc_engine_files::placement_is_held_in` decides which paths a hold
    /// covers.
    pub fn held_paths(&self, workspace: &str) -> Result<Vec<String>, StorageError> {
        self.read_with(|conn| {
            let sql = if workspace.is_empty() {
                "SELECT path FROM capture_file_holds"
            } else {
                "SELECT path FROM capture_file_holds WHERE workspace_id=?1"
            };
            let mut statement = conn
                .prepare_cached(sql)
                .map_err(StorageError::corrupt_public)?;
            let arguments = if workspace.is_empty() {
                Vec::new()
            } else {
                vec![workspace]
            };
            statement
                .query_map(rusqlite::params_from_iter(arguments), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(StorageError::corrupt_public)?
                .collect::<Result<_, _>>()
                .map_err(StorageError::corrupt_public)
        })
    }
}

/// Release only holds whose source alias has left the held object.
pub fn clear_orphaned_in(
    tx: &Transaction<'_>,
    workspace: &str,
    version: &str,
    path: &str,
) -> Result<(), StorageError> {
    tx.prepare_cached("DELETE FROM capture_file_holds WHERE workspace_id=?1 AND source_version_id=?2 AND path=?3 AND NOT EXISTS (SELECT 1 FROM path_aliases a WHERE a.workspace_id=capture_file_holds.workspace_id AND a.version_id=capture_file_holds.source_version_id AND a.path=capture_file_holds.path AND a.object_id=capture_file_holds.object_id)")
        .map_err(StorageError::persist_public)?.execute([workspace,version,path]).map_err(StorageError::persist_public)?;
    Ok(())
}

/// One lookup establishes both the hold and its source alias. Old orphan rows
/// are released in the caller's mutation transaction before ordinary capture.
pub fn pin_in(
    tx: &Transaction<'_>,
    workspace: &str,
    path: &str,
) -> Result<Option<CaptureFileHold>, StorageError> {
    let found = tx.prepare_cached("SELECT h.workspace_id,h.source_version_id,h.object_id,h.path,h.observed_sha256,h.observed_size,h.reason,h.observed_at_ms,h.attempt_count,h.retry_requested,a.object_id=h.object_id FROM capture_file_holds h LEFT JOIN path_aliases a ON a.workspace_id=h.workspace_id AND a.version_id=h.source_version_id AND a.path=h.path WHERE h.workspace_id=?1 AND h.path=?2")
        .map_err(StorageError::corrupt_public)?.query_row([workspace,path], |r| Ok((row(r)?,r.get::<_,Option<bool>>(10)?.unwrap_or(false))))
        .optional().map_err(StorageError::corrupt_public)?;
    match found {
        Some((hold, true)) => Ok(Some(hold)),
        Some((_, false)) => {
            clear_in(tx, workspace, path)?;
            Ok(None)
        }
        None => Ok(None),
    }
}

/// Capture has recorded this observation or its absence in the source version.
/// Only that commit can re-authorize selected-version placement against it.
/// `names_path` says whether a job's target names the recorded path on disk.
pub fn rebase_switch_jobs_in(
    tx: &Transaction<'_>,
    workspace: &str,
    names_path: impl Fn(&str) -> bool,
    preimage: &crate::Preimage,
) -> Result<(), StorageError> {
    let jobs = crate::pending_switch_jobs_in(tx, workspace)?;
    let (present, sha) = match preimage {
        crate::Preimage::Absent => (0, None),
        crate::Preimage::Present(sha) => (1, Some(sha.as_str())),
    };
    for (id, target) in jobs {
        if names_path(&target) {
            tx.execute("UPDATE materialization_jobs SET preimage_present=?2,preimage_sha256=?3 WHERE job_id=?1",
                params![id,present,sha]).map_err(StorageError::persist_public)?;
        }
    }
    Ok(())
}

/// Connection-local revision, including rolled-back changes, for blocker snapshots.
pub fn generation_in(conn: &Connection) -> rusqlite::Result<u64> {
    let generation: i64 = conn.query_row("SELECT dohc_placement_hold_generation()", [], |row| {
        row.get(0)
    })?;
    u64::try_from(generation).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, generation))
}
