//! The durable materialization-**job** ledger (`plan §Filesystem/database crash
//! boundary`, step 1 & 5). SQLite and the filesystem cannot share one
//! transaction, so the intent to write a file is made durable first: a job row
//! is committed in the same transaction as the canonical state it materializes.
//! A separate filesystem pipeline (`dohc-engine-files::materialize`) then
//! executes pending jobs — temp-write, flush, atomic replace — and marks them
//! complete, replaying idempotently at startup after any crash.
//!
//! This module owns the DB side of that contract: the job row shape, the
//! phase-1 enqueue (composed into a caller's transaction), and the phase-2
//! query/complete/conflict transitions. The filesystem side lives in
//! `dohc-engine-files` (a core-crate portability guardrail keeps direct
//! user-tree filesystem writes out of `dohc-engine-storage`).

use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction};

/// The expected on-disk state of the target immediately before the replace.
/// Revalidated by the filesystem pipeline: a mismatch means an external editor
/// wrote newer content, which must be preserved, never clobbered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preimage {
    /// The target is expected to be absent (a create).
    Absent,
    /// The target is expected to still hold exactly this content hash (an
    /// overwrite of known content).
    Present(String),
}

/// Filesystem operation represented by a durable materialization job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationOperation {
    Write,
    Delete,
}

impl MaterializationOperation {
    fn as_str(self) -> &'static str {
        match self {
            MaterializationOperation::Write => "write",
            MaterializationOperation::Delete => "delete",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "write" => Some(MaterializationOperation::Write),
            "delete" => Some(MaterializationOperation::Delete),
            _ => None,
        }
    }
}

/// The status of a materialization job. Only [`JobStatus::Pending`] is replayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    /// Enqueued, not yet materialized to disk.
    Pending,
    /// Materialized and durably recorded complete.
    Complete,
    /// The preimage revalidation found newer external content; the pipeline
    /// preserved both and did not overwrite. Terminal until a human/agent
    /// resolves it (never silently replayed).
    Conflict,
    /// Its target path was deleted before the job ever reached disk.
    /// Terminal, and distinct from `Conflict`: nothing needs a human's
    /// resolution here — the delete is the resolution. Never replayed.
    Cancelled,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Complete => "complete",
            JobStatus::Conflict => "conflict",
            JobStatus::Cancelled => "cancelled",
        }
    }
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(JobStatus::Pending),
            "complete" => Some(JobStatus::Complete),
            "conflict" => Some(JobStatus::Conflict),
            "cancelled" => Some(JobStatus::Cancelled),
            _ => None,
        }
    }
}

/// Inputs to phase 1: the durable intent to materialize `content_sha256` at
/// `target_path`. Composed into the caller's canonical-state transaction so the
/// job and the state it reflects commit together or not at all.
#[derive(Debug, Clone)]
pub struct MaterializationJobSpec {
    pub job_id: String,
    pub workspace_id: String,
    pub target_path: String,
    pub content_sha256: String,
    pub preimage: Preimage,
    pub target_generation: i64,
    pub now_ms: i64,
}

/// A job loaded from the ledger for phase-2 execution / replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializationJob {
    pub job_id: String,
    pub workspace_id: String,
    pub target_path: String,
    pub content_sha256: String,
    pub operation: MaterializationOperation,
    pub preimage: Preimage,
    pub target_generation: i64,
    pub status: JobStatus,
    pub created_at_ms: i64,
}

/// Enqueue a materialization job. The signature demands a `&Transaction`, not a
/// bare `&Connection`, so phase-1 atomicity (the job row + the canonical state
/// it reflects commit together, or neither) is **type-enforced**: enqueuing on
/// an autocommit connection — where each statement would commit independently —
/// is a compile error. Compose this into the same `write_with` transaction that
/// mutates the canonical state (`plan` step 1).
pub fn enqueue_job(
    tx: &Transaction<'_>,
    spec: &MaterializationJobSpec,
) -> Result<(), StorageError> {
    enqueue_operation(tx, spec, MaterializationOperation::Write)
}

/// Enqueue an explicit delete. Kept separate from [`enqueue_job`] so existing
/// write-producing domains cannot accidentally change operation semantics.
pub fn enqueue_delete_job(
    tx: &Transaction<'_>,
    spec: &MaterializationJobSpec,
) -> Result<(), StorageError> {
    enqueue_operation(tx, spec, MaterializationOperation::Delete)
}

/// Cancel pending write jobs targeting `path` in the same transaction as the
/// delete that removes the path from `path_aliases`. Preserve a prior
/// pending DELETE for the same path. After the prior delete clears the target,
/// the replay ladder's "target already absent" short-circuit makes a later
/// delete idempotent even if its preimage is stale. An empty `workspace_id` is
/// the legacy global sentinel and matches every workspace's jobs for the path.
pub fn cancel_pending_jobs_for_path(
    tx: &Transaction<'_>,
    workspace_id: &str,
    path: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    tx.execute(
        "UPDATE materialization_jobs SET status = 'cancelled', completed_at_ms = ?3 \
         WHERE status = 'pending' AND operation = 'write' AND target_path = ?2 \
           AND (?1 = '' OR workspace_id = ?1 OR workspace_id = '')",
        rusqlite::params![workspace_id, path, now_ms],
    )
    .map_err(StorageError::persist)
}

/// Insert or refresh a durable projection intent. Active-version switching
/// uses stable job ids so the same destination can be projected repeatedly
/// after another version has occupied the workspace folder.
pub fn upsert_projection_job(
    tx: &Transaction<'_>,
    spec: &MaterializationJobSpec,
    operation: MaterializationOperation,
) -> Result<(), StorageError> {
    let (present, preimage_sha): (i64, Option<&str>) = match &spec.preimage {
        Preimage::Absent => (0, None),
        Preimage::Present(sha) => (1, Some(sha.as_str())),
    };
    tx.execute(
        "INSERT INTO materialization_jobs \
         (job_id, workspace_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, NULL, ?9) \
         ON CONFLICT(job_id) DO UPDATE SET \
             workspace_id = excluded.workspace_id, \
             target_path = excluded.target_path, \
             content_sha256 = excluded.content_sha256, \
             preimage_present = excluded.preimage_present, \
             preimage_sha256 = excluded.preimage_sha256, \
             target_generation = excluded.target_generation, \
             status = 'pending', \
             created_at_ms = excluded.created_at_ms, \
             completed_at_ms = NULL, \
             operation = excluded.operation",
        rusqlite::params![
            spec.job_id,
            spec.workspace_id,
            spec.target_path,
            spec.content_sha256,
            present,
            preimage_sha,
            spec.target_generation,
            spec.now_ms,
            operation.as_str(),
        ],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

/// Record a write job that is already satisfied on disk, as `'complete'`.
/// Capture uses this: its bytes came FROM the file, so nothing must ever run —
/// but the completed-generation marker is what lets the materializer's
/// staleness gate supersede an older still-pending job for the same path.
/// Without it, a stale pending job whose preimage matches the just-captured
/// disk bytes could later run and regress disk behind the captured head.
///
/// Upsert, deliberately, for the two legitimate same-id cases:
/// - A rolled-back capture leaves its completed marker behind while the
///   moment's deletion frees its order; the next capture of the path derives
///   the same moment/job id and must reclaim the row (the fresh moment insert
///   succeeding proves the id was free in `moments`, so a surviving job row
///   is a dead remnant, never a live unrelated job).
/// - A deduped capture confirms a head whose creating write's own job may
///   still be pending (its content is by construction the head's sha — the
///   very bytes just verified on disk); flipping it complete records reality
///   and immunizes the path against older stale pending jobs.
pub fn record_completed_job(
    tx: &Transaction<'_>,
    spec: &MaterializationJobSpec,
) -> Result<(), StorageError> {
    let (present, preimage_sha): (i64, Option<&str>) = match &spec.preimage {
        Preimage::Absent => (0, None),
        Preimage::Present(sha) => (1, Some(sha.as_str())),
    };
    tx.execute(
        "INSERT INTO materialization_jobs \
         (job_id, workspace_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'complete', ?8, ?8, 'write') \
         ON CONFLICT(job_id) DO UPDATE SET \
             workspace_id = excluded.workspace_id, \
             target_path = excluded.target_path, \
             content_sha256 = excluded.content_sha256, \
             preimage_present = excluded.preimage_present, \
             preimage_sha256 = excluded.preimage_sha256, \
             target_generation = excluded.target_generation, \
             status = 'complete', \
             completed_at_ms = excluded.completed_at_ms, \
             operation = 'write'",
        rusqlite::params![
            spec.job_id,
            spec.workspace_id,
            spec.target_path,
            spec.content_sha256,
            present,
            preimage_sha,
            spec.target_generation,
            spec.now_ms,
        ],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

/// Record that CAPTURE observed this secret's plaintext in the workspace file.
///
/// That observation — a capture write, a capture retire, or a capture dedupe
/// that verified the bytes already match — is what lets capture claim or retire
/// the secret later. The caller-supplied `metadata_origin` cannot carry it:
/// RPC callers and replication peers choose that string, including the value
/// capture itself writes.
///
/// Scoped by workspace because `secret_moments` is keyed by
/// `(workspace_id, moment_id)` and RPC callers choose their own moment ids, so
/// a bare id can name a different workspace's moment. `after_present = 1`
/// selects write moments: a delete means the plaintext is gone, which grants
/// no ownership.
pub fn stamp_secret_capture_owned(
    tx: &Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE secret_moments SET capture_owned = 1 \
         WHERE workspace_id = ?1 AND moment_id = ?2 AND after_present = 1",
        rusqlite::params![workspace_id, moment_id],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

fn enqueue_operation(
    tx: &Transaction<'_>,
    spec: &MaterializationJobSpec,
    operation: MaterializationOperation,
) -> Result<(), StorageError> {
    let (present, preimage_sha): (i64, Option<&str>) = match &spec.preimage {
        Preimage::Absent => (0, None),
        Preimage::Present(sha) => (1, Some(sha.as_str())),
    };
    tx.execute(
        "INSERT INTO materialization_jobs \
         (job_id, workspace_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, NULL, ?9)",
        rusqlite::params![
            spec.job_id,
            spec.workspace_id,
            spec.target_path,
            spec.content_sha256,
            present,
            preimage_sha,
            spec.target_generation,
            spec.now_ms,
            operation.as_str(),
        ],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MaterializationJob> {
    let present: i64 = row.get(4)?;
    let preimage_sha: Option<String> = row.get(5)?;
    let preimage = if present != 0 {
        Preimage::Present(preimage_sha.unwrap_or_default())
    } else {
        Preimage::Absent
    };
    let status_raw: String = row.get(7)?;
    let status = JobStatus::parse(&status_raw).unwrap_or(JobStatus::Conflict);
    let operation_raw: String = row.get(9)?;
    let operation = MaterializationOperation::parse(&operation_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            9,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown materialization operation",
            )),
        )
    })?;
    Ok(MaterializationJob {
        job_id: row.get(0)?,
        workspace_id: row.get(1)?,
        target_path: row.get(2)?,
        content_sha256: row.get(3)?,
        operation,
        preimage,
        target_generation: row.get(6)?,
        status,
        created_at_ms: row.get(8)?,
    })
}

const JOB_COLUMNS: &str = "job_id, workspace_id, target_path, content_sha256, preimage_present, \
     preimage_sha256, target_generation, status, created_at_ms, operation";

/// Every pending job, oldest first (then by id for determinism). The set the
/// filesystem pipeline replays at startup and executes on enqueue.
pub(crate) fn list_pending_jobs(
    conn: &Connection,
) -> Result<Vec<MaterializationJob>, StorageError> {
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM materialization_jobs \
         WHERE status = 'pending' ORDER BY created_at_ms ASC, job_id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(StorageError::corrupt)?;
    let rows = stmt
        .query_map([], row_to_job)
        .map_err(StorageError::corrupt)?;
    let mut jobs = Vec::new();
    for job in rows {
        jobs.push(job.map_err(StorageError::corrupt)?);
    }
    Ok(jobs)
}

/// Load a single job by id.
pub fn load_job(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<MaterializationJob>, StorageError> {
    let sql = format!("SELECT {JOB_COLUMNS} FROM materialization_jobs WHERE job_id = ?1");
    conn.query_row(&sql, [job_id], row_to_job)
        .optional()
        .map_err(StorageError::corrupt)
}

/// Transition a job to a terminal status. Idempotent: re-marking an already
/// terminal job to the same status is a no-op (the pipeline replay may mark a
/// job complete that a prior run already completed).
fn set_status(
    conn: &Connection,
    job_id: &str,
    status: JobStatus,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE materialization_jobs SET status = ?2, completed_at_ms = ?3 WHERE job_id = ?1",
        rusqlite::params![job_id, status.as_str(), now_ms],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

/// Mark a job complete (its content is durably on disk).
///
/// Deliberately does not stamp secret capture ownership. The materializer
/// writing a secret's plaintext to disk is the engine projecting API state
/// outward, not capture observing the user's file; treating it as ownership
/// would let a disk delete retire an API-written secret. Ownership is stamped
/// only where capture itself observed the file — see
/// [`stamp_secret_capture_owned`].
pub(crate) fn mark_complete(
    conn: &Connection,
    job_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    set_status(conn, job_id, JobStatus::Complete, now_ms)
}

/// Mark a job in conflict (newer external content was preserved; not clobbered).
pub(crate) fn mark_conflict(
    conn: &Connection,
    job_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    set_status(conn, job_id, JobStatus::Conflict, now_ms)
}

/// Requeue a conflict after the caller has proved that its conflicting disk
/// preimage is gone. The status predicate prevents an older recovery attempt
/// from reviving a job that another writer already completed or cancelled.
pub(crate) fn requeue_conflict(conn: &Connection, job_id: &str) -> Result<bool, StorageError> {
    conn.execute(
        "UPDATE materialization_jobs SET status = 'pending', completed_at_ms = NULL \
         WHERE job_id = ?1 AND status = 'conflict'",
        [job_id],
    )
    .map(|changed| changed == 1)
    .map_err(StorageError::persist)
}

/// Where a displaced file stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplacementState {
    /// Written before the materializer moves the target aside. The job's own
    /// content is not at the target yet, so a crash that leaves the target
    /// name empty is undone by moving the displaced file back.
    Open,
    /// The job's content is at the target. The displaced file held bytes the
    /// store has and only waits to be deleted; recovery never moves it back.
    Placed,
    /// The displaced file held bytes the store does not have, and could not
    /// go back to its path. It stays at its displaced name and this row is the
    /// evidence of that outside change until the engine captures it.
    Kept,
}

impl DisplacementState {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "open" => Some(DisplacementState::Open),
            "placed" => Some(DisplacementState::Placed),
            "kept" => Some(DisplacementState::Kept),
            _ => None,
        }
    }
}

/// Inputs to [`open_displacement`], for the file the materializer is about to
/// move off `target_path` before it writes or deletes that path.
#[derive(Debug, Clone)]
pub struct DisplacementSpec {
    pub job_id: String,
    pub workspace_id: String,
    pub target_path: String,
    /// File name, in the target's directory, the target moves to.
    pub displaced_name: String,
    /// The bytes the job expects to move aside, its preimage.
    pub expected_sha256: String,
    /// The bytes the job writes, or `None` for a delete.
    pub content_sha256: Option<String>,
    pub now_ms: i64,
}

/// A file the materializer moved off a target path.
///
/// The row is written `open` before the move. The materializer then reads the
/// moved file. When the store holds its bytes, the job goes ahead and the file
/// is deleted with its row. Otherwise another program wrote it after the
/// preimage check: the file goes back to its path and the job conflicts. The
/// row turns `kept` only when the file cannot go back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Displacement {
    pub displacement_id: i64,
    pub job_id: String,
    pub workspace_id: String,
    pub target_path: String,
    pub displaced_name: String,
    pub expected_sha256: String,
    pub content_sha256: Option<String>,
    pub state: DisplacementState,
    /// For a kept file, the hash of the bytes it held when inspected. `None`
    /// when they could not be read whole: over the cap, not a regular file,
    /// unreadable, or still open for writing by another program. Replay
    /// inspects such a file again.
    pub displaced_sha256: Option<String>,
    pub created_at_ms: i64,
}

/// How [`resolve_displacement`] ends a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplacementResolution<'a> {
    /// Delete the row: nothing is left at the displaced name.
    Discard,
    /// Keep the row as the evidence of an outside change.
    Keep { displaced_sha256: Option<&'a str> },
}

const DISPLACEMENT_COLUMNS: &str = "displacement_id, job_id, workspace_id, target_path, \
     displaced_name, expected_sha256, content_sha256, state, displaced_sha256, created_at_ms";

fn row_to_displacement(row: &rusqlite::Row<'_>) -> rusqlite::Result<Displacement> {
    let state_raw: String = row.get(7)?;
    let state = DisplacementState::parse(&state_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown displacement state",
            )),
        )
    })?;
    Ok(Displacement {
        displacement_id: row.get(0)?,
        job_id: row.get(1)?,
        workspace_id: row.get(2)?,
        target_path: row.get(3)?,
        displaced_name: row.get(4)?,
        expected_sha256: row.get(5)?,
        content_sha256: row.get(6)?,
        state,
        displaced_sha256: row.get(8)?,
        created_at_ms: row.get(9)?,
    })
}

fn query_displacements(
    conn: &Connection,
    filter: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<Displacement>, StorageError> {
    let sql = format!(
        "SELECT {DISPLACEMENT_COLUMNS} FROM materialization_displacements \
         WHERE {filter} ORDER BY displacement_id"
    );
    let mut stmt = conn.prepare(&sql).map_err(StorageError::corrupt)?;
    let rows = stmt
        .query_map(params, row_to_displacement)
        .map_err(StorageError::corrupt)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt)
}

/// Record, before the move, that the materializer is about to move a target
/// aside. Returns the row id later transitions name.
pub(crate) fn open_displacement(
    conn: &Connection,
    spec: &DisplacementSpec,
) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO materialization_displacements \
         (job_id, workspace_id, target_path, displaced_name, expected_sha256, content_sha256, \
          state, displaced_sha256, created_at_ms, resolved_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', NULL, ?7, NULL)",
        rusqlite::params![
            spec.job_id,
            spec.workspace_id,
            spec.target_path,
            spec.displaced_name,
            spec.expected_sha256,
            spec.content_sha256,
            spec.now_ms,
        ],
    )
    .map_err(StorageError::persist)?;
    Ok(conn.last_insert_rowid())
}

/// Record that the job's content is at the target, before the displaced
/// file is deleted.
pub(crate) fn mark_displacement_placed(
    conn: &Connection,
    displacement_id: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE materialization_displacements SET state = 'placed' \
         WHERE displacement_id = ?1 AND state = 'open'",
        [displacement_id],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

/// End a row and, in the same transaction, give its job a terminal status.
pub(crate) fn resolve_displacement(
    conn: &Connection,
    displacement_id: i64,
    resolution: DisplacementResolution<'_>,
    job: Option<(&str, JobStatus)>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(StorageError::persist)?;
    match resolution {
        DisplacementResolution::Discard => tx.execute(
            "DELETE FROM materialization_displacements WHERE displacement_id = ?1",
            [displacement_id],
        ),
        DisplacementResolution::Keep { displaced_sha256 } => tx.execute(
            "UPDATE materialization_displacements \
             SET state = 'kept', displaced_sha256 = ?2, resolved_at_ms = ?3 \
             WHERE displacement_id = ?1",
            rusqlite::params![displacement_id, displaced_sha256, now_ms],
        ),
    }
    .map_err(StorageError::persist)?;
    if let Some((job_id, status)) = job {
        set_status(&tx, job_id, status, now_ms)?;
    }
    tx.commit().map_err(StorageError::persist)
}

/// Rows a replay must look at, oldest first: every open or placed row, and
/// every kept row whose bytes could not be read.
pub(crate) fn list_unsettled_displacements(
    conn: &Connection,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(
        conn,
        "state IN ('open', 'placed') OR (state = 'kept' AND displaced_sha256 IS NULL)",
        [],
    )
}

/// Every row of one job, in any state, oldest first.
pub(crate) fn list_displacements_for_job(
    conn: &Connection,
    job_id: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(conn, "job_id = ?1", [job_id])
}

/// Kept rows for one workspace, oldest first. They are the outside changes the
/// engine has not captured yet.
pub(crate) fn list_kept_displacements(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(conn, "state = 'kept' AND workspace_id = ?1", [workspace_id])
}

/// Whether an open row names `path`: a replace moved that path aside and
/// has not put anything back yet, so its absence on disk is not a delete.
/// An empty `workspace_id` on either side matches every workspace.
pub(crate) fn path_is_displaced(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM materialization_displacements \
         WHERE state = 'open' AND target_path = ?2 \
           AND (?1 = '' OR workspace_id = ?1 OR workspace_id = ''))",
        [workspace_id, path],
        |row| row.get(0),
    )
    .map_err(StorageError::corrupt)
}

/// Whether the store holds content with this hash, as a text or binary blob.
pub(crate) fn holds_content(conn: &Connection, sha256: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?1) \
             OR EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = ?1)",
        [sha256],
        |row| row.get(0),
    )
    .map_err(StorageError::corrupt)
}

/// The number of pending jobs (cheap gauge for tests / startup logging).
pub(crate) fn pending_job_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
    .map_err(StorageError::corrupt)
}

/// The highest ordinary moment-order `target_generation` among complete jobs
/// for `path` in `workspace_id`, including legacy rows whose workspace
/// coordinate predates the column, or `None` if nothing has been materialized
/// there yet. An empty caller coordinate is itself a legacy global job, so its
/// fence spans every workspace. Active
/// version projections use snapshot timestamps, which are a different
/// namespace and therefore cannot participate in this ordering fence. The
/// materialization pipeline uses this to skip a pending ordinary job whose
/// generation is superseded by an already-materialized newer generation for
/// the same path (concurrent/out-of-order jobs must never regress a path).
pub(crate) fn max_completed_generation_for_path(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<Option<i64>, StorageError> {
    // MAX over an empty set yields a single NULL row → `None`.
    conn.query_row(
        "SELECT MAX(target_generation) FROM materialization_jobs \
         WHERE (?1 = '' OR workspace_id = ?1 OR workspace_id = '') \
           AND target_path = ?2 AND status = 'complete' \
           AND job_id NOT LIKE 'version-switch-%'",
        [workspace_id, path],
        |r| r.get::<_, Option<i64>>(0),
    )
    .map_err(StorageError::corrupt)
}
