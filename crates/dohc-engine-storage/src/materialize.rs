//! The durable materialization-**job** ledger (`plan §Filesystem/database crash
//! boundary`, step 1 & 5). SQLite and the filesystem cannot share one
//! transaction, so the intent to write a file is made durable FIRST: a job row
//! is committed in the SAME transaction as the canonical state it materializes.
//! A separate filesystem pipeline (`dohc-engine-files::materialize`) then
//! executes PENDING jobs — temp-write, flush, atomic replace — and marks them
//! COMPLETE, replaying idempotently at startup after any crash.
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
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Complete => "complete",
            JobStatus::Conflict => "conflict",
        }
    }
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(JobStatus::Pending),
            "complete" => Some(JobStatus::Complete),
            "conflict" => Some(JobStatus::Conflict),
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
         (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, NULL, ?8) \
         ON CONFLICT(job_id) DO UPDATE SET \
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

/// Record a write job that is ALREADY satisfied on disk, as `'complete'`.
/// Capture uses this: its bytes came FROM the file, so nothing must ever run —
/// but the completed-generation marker is what lets the materializer's
/// staleness gate supersede an OLDER still-pending job for the same path.
/// Without it, a stale pending job whose preimage matches the just-captured
/// disk bytes could later run and regress disk behind the captured head.
///
/// UPSERT, deliberately, for the two legitimate same-id cases:
/// - A rolled-back capture leaves its completed marker behind while the
///   moment's deletion frees its order; the NEXT capture of the path derives
///   the same moment/job id and must reclaim the row (the fresh moment insert
///   succeeding proves the id was free in `moments`, so a surviving job row
///   is a dead remnant, never a live unrelated job).
/// - A deduped capture confirms a head whose creating write's OWN job may
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
         (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'complete', ?7, ?7, 'write') \
         ON CONFLICT(job_id) DO UPDATE SET \
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
/// selects write moments: a delete means the plaintext is GONE, which grants
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
         (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
          target_generation, status, created_at_ms, completed_at_ms, operation) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, NULL, ?8)",
        rusqlite::params![
            spec.job_id,
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
    let present: i64 = row.get(3)?;
    let preimage_sha: Option<String> = row.get(4)?;
    let preimage = if present != 0 {
        Preimage::Present(preimage_sha.unwrap_or_default())
    } else {
        Preimage::Absent
    };
    let status_raw: String = row.get(6)?;
    let status = JobStatus::parse(&status_raw).unwrap_or(JobStatus::Conflict);
    let operation_raw: String = row.get(8)?;
    let operation = MaterializationOperation::parse(&operation_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            8,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown materialization operation",
            )),
        )
    })?;
    Ok(MaterializationJob {
        job_id: row.get(0)?,
        target_path: row.get(1)?,
        content_sha256: row.get(2)?,
        operation,
        preimage,
        target_generation: row.get(5)?,
        status,
        created_at_ms: row.get(7)?,
    })
}

const JOB_COLUMNS: &str = "job_id, target_path, content_sha256, preimage_present, \
     preimage_sha256, target_generation, status, created_at_ms, operation";

/// Every pending job, oldest first (then by id for determinism). The set the
/// filesystem pipeline replays at startup and executes on enqueue.
pub fn list_pending_jobs(conn: &Connection) -> Result<Vec<MaterializationJob>, StorageError> {
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
/// Deliberately does NOT stamp secret capture ownership. The materializer
/// writing a secret's plaintext to disk is the engine projecting API state
/// outward, not capture observing the user's file; treating it as ownership
/// would let a disk delete retire an API-written secret. Ownership is stamped
/// only where capture itself observed the file — see
/// [`stamp_secret_capture_owned`].
pub fn mark_complete(conn: &Connection, job_id: &str, now_ms: i64) -> Result<(), StorageError> {
    set_status(conn, job_id, JobStatus::Complete, now_ms)
}

/// Mark a job in conflict (newer external content was preserved; not clobbered).
pub fn mark_conflict(conn: &Connection, job_id: &str, now_ms: i64) -> Result<(), StorageError> {
    set_status(conn, job_id, JobStatus::Conflict, now_ms)
}

/// The number of pending jobs (cheap gauge for tests / startup logging).
pub fn pending_job_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
    .map_err(StorageError::corrupt)
}

/// The highest `target_generation` among COMPLETE jobs for `path`, or `None` if
/// nothing has been materialized there yet. The materialization pipeline uses
/// this to skip a pending job whose generation is superseded by an already-
/// materialized newer generation for the same path (concurrent/out-of-order
/// jobs must never regress a path to older content).
pub fn max_completed_generation_for_path(
    conn: &Connection,
    path: &str,
) -> Result<Option<i64>, StorageError> {
    // MAX over an empty set yields a single NULL row → `None`.
    conn.query_row(
        "SELECT MAX(target_generation) FROM materialization_jobs \
         WHERE target_path = ?1 AND status = 'complete'",
        [path],
        |r| r.get::<_, Option<i64>>(0),
    )
    .map_err(StorageError::corrupt)
}
