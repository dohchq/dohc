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
    /// A delete or newer publication superseded this job before it reached disk.
    /// Terminal; never replayed.
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
    let preimage = match (present, preimage_sha) {
        (0, None) => Preimage::Absent,
        (1, Some(sha)) if !sha.is_empty() => Preimage::Present(sha),
        _ => {
            return Err(invalid_job_field(
                4,
                rusqlite::types::Type::Integer,
                "invalid materialization preimage",
            ));
        }
    };
    let status_raw: String = row.get(7)?;
    let status = JobStatus::parse(&status_raw).ok_or_else(|| {
        invalid_job_field(
            7,
            rusqlite::types::Type::Text,
            "unknown materialization status",
        )
    })?;
    let operation_raw: String = row.get(9)?;
    let operation = MaterializationOperation::parse(&operation_raw).ok_or_else(|| {
        invalid_job_field(
            9,
            rusqlite::types::Type::Text,
            "unknown materialization operation",
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

fn invalid_job_field(
    index: usize,
    kind: rusqlite::types::Type,
    message: &'static str,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        kind,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

const JOB_COLUMNS: &str = "job_id, workspace_id, target_path, content_sha256, preimage_present, \
     preimage_sha256, target_generation, status, created_at_ms, operation";

/// Every pending job, oldest first, then by id for determinism. The set the
/// filesystem pipeline replays at startup and executes on enqueue. Checked
/// deletes are left to their own recovery.
pub(crate) fn list_pending_jobs(
    conn: &Connection,
) -> Result<Vec<MaterializationJob>, StorageError> {
    let invalid_status: bool = conn
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM materialization_jobs \
             WHERE status < ?1 \
                OR (status > ?1 AND status < ?2) \
                OR (status > ?2 AND status < ?3) \
                OR (status > ?3 AND status < ?4) \
                OR status > ?4)",
        )
        .map_err(StorageError::corrupt)?
        .query_row(
            [
                JobStatus::Cancelled.as_str(),
                JobStatus::Complete.as_str(),
                JobStatus::Conflict.as_str(),
                JobStatus::Pending.as_str(),
            ],
            |row| row.get(0),
        )
        .map_err(StorageError::corrupt)?;
    if invalid_status {
        return Err(StorageError::corrupt(invalid_job_field(
            7,
            rusqlite::types::Type::Text,
            "unknown materialization status",
        )));
    }
    list_jobs(conn, true)
}

pub(crate) fn list_jobs(
    conn: &Connection,
    pending_only: bool,
) -> Result<Vec<MaterializationJob>, StorageError> {
    let filter = if pending_only {
        "WHERE status = 'pending' AND job_id NOT GLOB 'restore-delete-mat_*'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM materialization_jobs j \
         {filter} ORDER BY created_at_ms ASC, job_id ASC"
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(StorageError::corrupt)?;
    let rows = stmt
        .query_map([], row_to_job)
        .map_err(StorageError::corrupt)?;
    let mut jobs = Vec::new();
    for job in rows {
        jobs.push(job.map_err(StorageError::corrupt)?);
    }
    Ok(jobs)
}

/// Pending switch intents in the replay workspace, including legacy unscoped rows.
pub fn pending_switch_jobs_in(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn.prepare_cached(
        "SELECT job_id,target_path FROM materialization_jobs WHERE workspace_id IN (?1,'') AND status='pending' AND job_id GLOB 'version-switch-*'"
    ).map_err(StorageError::corrupt_public)?;
    statement
        .query_map([workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt_public)
}

/// Without statistics SQLite picks the status index and reads every pending
/// job, so the query names its index.
fn pending_merge_deletes_sql() -> String {
    format!(
        "SELECT {JOB_COLUMNS} FROM materialization_jobs \
         INDEXED BY idx_materialization_jobs_pending_delete_preimage \
         WHERE status = 'pending' AND operation = 'delete' AND job_id GLOB 'merge-mat_*' \
           AND workspace_id IN (?1, '') AND preimage_present = 1 AND preimage_sha256 = ?2 \
         ORDER BY created_at_ms ASC, job_id ASC"
    )
}

/// Pending merge deletes in a workspace, including legacy unscoped rows, that
/// expect `preimage_sha256` at their path.
pub(crate) fn pending_merge_deletes_expecting(
    conn: &Connection,
    workspace_id: &str,
    preimage_sha256: &str,
) -> Result<Vec<MaterializationJob>, StorageError> {
    let mut stmt = conn
        .prepare_cached(&pending_merge_deletes_sql())
        .map_err(StorageError::corrupt)?;
    let rows = stmt
        .query_map([workspace_id, preimage_sha256], row_to_job)
        .map_err(StorageError::corrupt)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt)
}

pub(crate) fn has_pending_job_for_path(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<bool, StorageError> {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM materialization_jobs WHERE status = 'pending' AND target_path = ?2 AND (?1 = '' OR workspace_id = ?1 OR workspace_id = ''))", [workspace_id, path], |row| row.get(0)).map_err(StorageError::corrupt)
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

pub(crate) fn mark_cancelled(
    conn: &Connection,
    job_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    set_status(conn, job_id, JobStatus::Cancelled, now_ms)
}

/// The publication job id of moment `m`, from its recorded kind: binary
/// writes prefix the moment id with `binary-mat_` (the domain's
/// `binary_write_job_id`), text writes with `authored-mat_`. A job is that
/// moment's only when its workspace and generation also match the moment.
pub const MOMENT_PUBLICATION_JOB_SQL: &str = "CASE m.after_content_kind WHEN 'binary' \
     THEN 'binary-mat_' || m.moment_id ELSE 'authored-mat_' || m.moment_id END";

/// Record that the keyed write this job publishes never reached disk.
pub(crate) fn record_superseded_publication(
    conn: &Connection,
    job: &MaterializationJob,
) -> Result<(), StorageError> {
    conn.execute(
        &format!(
            "UPDATE engine_requests SET publication_outcome = 'superseded' \
             WHERE kind = 'versioned' AND publication_outcome IS NULL AND result_seq = \
             (SELECT m.moment_order FROM moments m WHERE m.workspace_id = ?1 \
              AND m.moment_order = ?2 AND {MOMENT_PUBLICATION_JOB_SQL} = ?3)"
        ),
        rusqlite::params![job.workspace_id, job.target_generation, job.job_id],
    )
    .map_err(StorageError::persist)?;
    Ok(())
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
    /// The displaced file holds bytes the store does not have, and has not
    /// gone back to its path yet. Recovery puts it back.
    Open,
    /// The displaced file held bytes the store does not have, and could not
    /// go back to its path. It stays in the staging directory and this row is
    /// the evidence of that outside change until the engine captures it.
    Kept,
}

impl DisplacementState {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "open" => Some(DisplacementState::Open),
            "kept" => Some(DisplacementState::Kept),
            _ => None,
        }
    }
}

/// Inputs to [`open_displacement`] and [`keep_displacement`], for a file the
/// materializer moved off `target_path` into its staging directory.
#[derive(Debug, Clone)]
pub struct DisplacementSpec {
    pub job_id: String,
    pub workspace_id: String,
    /// Empty for a staged file no job identifies.
    pub target_path: String,
    /// File name, in the staging directory, the target moved to.
    pub displaced_name: String,
    /// The bytes the job expected to move aside, its preimage. Empty when no
    /// job identifies the file.
    pub expected_sha256: String,
    /// The bytes the job writes, or `None` for a delete.
    pub content_sha256: Option<String>,
    pub now_ms: i64,
}

/// A file the materializer moved off a target path whose bytes the store does
/// not have.
///
/// A moved file the store holds needs no row: it is deleted, and a crash
/// before that leaves a staged file whose name recovery decodes. Bytes the
/// store lacks get an `open` row before anything else happens to them. The
/// file then goes back to its path and the row is deleted, or the row turns
/// `kept` when the file cannot go back.
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

/// Which rows come first.
#[derive(Clone, Copy)]
enum Order {
    /// For evidence: in the order the outside changes happened.
    OldestFirst,
    /// For recovery: the last file moved off a path held its newest bytes, so
    /// it goes back first and an older displaced file then finds the name
    /// taken instead of taking it.
    NewestFirst,
}

fn query_displacements(
    conn: &Connection,
    filter: &str,
    order: Order,
    params: impl rusqlite::Params,
) -> Result<Vec<Displacement>, StorageError> {
    let direction = match order {
        Order::OldestFirst => "ASC",
        Order::NewestFirst => "DESC",
    };
    let sql = format!(
        "SELECT {DISPLACEMENT_COLUMNS} FROM materialization_displacements \
         WHERE {filter} ORDER BY displacement_id {direction}"
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(StorageError::corrupt)?;
    let rows = stmt
        .query_map(params, row_to_displacement)
        .map_err(StorageError::corrupt)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt)
}

/// Record that a staged file holds bytes the store does not have, before the
/// materializer moves anything to put it back. Returns the row id later
/// transitions name.
///
/// The engine runs with `synchronous = NORMAL`, where an operating-system
/// crash can lose recent commits while file renames survive. This commit alone
/// runs with `synchronous = FULL`, which syncs the WAL, so no rename that
/// follows outlives the row that says the file must not be deleted. Every
/// earlier commit is synced with it. The connection's own setting is restored
/// after.
pub(crate) fn open_displacement(
    conn: &Connection,
    spec: &DisplacementSpec,
) -> Result<i64, StorageError> {
    Ok(open_displacements(conn, std::slice::from_ref(spec))?[0])
}

/// Adopt a recovery sweep's unknown files with one WAL sync.
pub(crate) fn open_displacements(
    conn: &Connection,
    specs: &[DisplacementSpec],
) -> Result<Vec<i64>, StorageError> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    with_full_commit(conn, |tx| {
        let mut ids = Vec::with_capacity(specs.len());
        for spec in specs {
            tx.execute(
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
            ids.push(tx.last_insert_rowid());
        }
        Ok(ids)
    })
}

/// Record a staged file that stays where it is as a `kept` row, in an
/// FULL commit before resolving it as kept.
pub(crate) fn keep_displacement(
    conn: &Connection,
    spec: &DisplacementSpec,
    displaced_sha256: Option<&str>,
) -> Result<(), StorageError> {
    let id = open_displacement(conn, spec)?;
    resolve_displacement(
        conn,
        id,
        DisplacementResolution::Keep { displaced_sha256 },
        None,
        spec.now_ms,
    )
}

/// Names held by displacement rows, including retained copies.
pub(crate) fn displacement_names(
    conn: &Connection,
) -> Result<std::collections::HashSet<String>, StorageError> {
    let mut query = conn
        .prepare("SELECT displaced_name FROM materialization_displacements")
        .map_err(StorageError::corrupt)?;
    query
        .query_map([], |row| row.get(0))
        .map_err(StorageError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt)
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

/// Rows a replay must look at, newest first: every open row, and every kept
/// row whose bytes could not be read.
pub(crate) fn list_unsettled_displacements(
    conn: &Connection,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(
        conn,
        "state = 'open' OR (state = 'kept' AND displaced_sha256 IS NULL)",
        Order::NewestFirst,
        [],
    )
}

/// Open rows for one path, from any job, newest first. An empty
/// `workspace_id` on either side matches every workspace.
pub(crate) fn list_unsettled_displacements_for_path(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(
        conn,
        "state = 'open' AND target_path = ?2 \
         AND (?1 = '' OR workspace_id = ?1 OR workspace_id = '')",
        Order::NewestFirst,
        [workspace_id, path],
    )
}

/// Every row of one job, in any state, newest first.
pub(crate) fn list_displacements_for_job(
    conn: &Connection,
    job_id: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(conn, "job_id = ?1", Order::NewestFirst, [job_id])
}

/// Kept rows for one workspace, oldest first. They are the outside changes the
/// engine has not captured yet.
pub(crate) fn list_kept_displacements(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(
        conn,
        "state = 'kept' AND (workspace_id = ?1 OR workspace_id = '')",
        Order::OldestFirst,
        [workspace_id],
    )
}

/// Whether an open row names `path`: a replace moved bytes the store lacks
/// off that path and has not put them back yet, so its absence on disk is not
/// a delete. Staged files without a row are the materializer's to find. An
/// empty `workspace_id` on either side matches every workspace.
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
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?1) \
             OR EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = ?1)",
    )
    .map_err(StorageError::corrupt)?
    .query_row([sha256], |row| row.get(0))
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
/// fence spans every workspace. Active version projections (`version-switch-`
/// jobs) use snapshot timestamps, which are a different namespace and
/// therefore cannot participate in this ordering fence. The
/// materialization pipeline uses this to skip a pending ordinary job whose
/// generation is superseded by an already-materialized newer generation for
/// the same path (concurrent/out-of-order jobs must never regress a path).
pub(crate) fn max_completed_generation_for_path(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<Option<i64>, StorageError> {
    // MAX over an empty set yields a single NULL row → `None`.
    conn.prepare_cached(
        "SELECT MAX(target_generation) FROM materialization_jobs \
         WHERE (?1 = '' OR workspace_id = ?1 OR workspace_id = '') \
           AND target_path = ?2 AND status = 'complete' \
           AND job_id NOT LIKE 'version-switch-%'",
    )
    .map_err(StorageError::corrupt)?
    .query_row([workspace_id, path], |r| r.get::<_, Option<i64>>(0))
    .map_err(StorageError::corrupt)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedDisplacement {
    pub displacement_id: i64,
    pub job_id: String,
    pub workspace_id: String,
    pub target_path: String,
    pub source_path: String,
    pub device: String,
    pub inode: String,
    pub digest: String,
    pub size: i64,
    pub mtime: String,
    pub ctime: String,
    pub changed_at_ms: i64,
    /// The source's volume cannot refuse to unlink a file a process has open,
    /// so the sweep never releases it. Only an explicit delete does.
    pub busy_check_unsupported: bool,
}

/// What `release_blocked` records for a volume that cannot refuse to unlink
/// an open file.
const BUSY_CHECK_UNSUPPORTED: &str = "busy-check-unsupported";

const RETAINED_COLUMNS: &str = "displacement_id,job_id,workspace_id,target_path,source_path,device,inode,digest,size,mtime,ctime,changed_at_ms,release_blocked IS NOT NULL";

fn retained_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RetainedDisplacement> {
    Ok(RetainedDisplacement {
        displacement_id: r.get(0)?,
        job_id: r.get(1)?,
        workspace_id: r.get(2)?,
        target_path: r.get(3)?,
        source_path: r.get(4)?,
        device: r.get(5)?,
        inode: r.get(6)?,
        digest: r.get(7)?,
        size: r.get(8)?,
        mtime: r.get(9)?,
        ctime: r.get(10)?,
        changed_at_ms: r.get(11)?,
        busy_check_unsupported: r.get(12)?,
    })
}

fn release_blocked(row: &RetainedDisplacement) -> Option<&'static str> {
    row.busy_check_unsupported.then_some(BUSY_CHECK_UNSUPPORTED)
}

pub(crate) fn retained_rows(
    conn: &Connection,
    after: i64,
) -> Result<Vec<RetainedDisplacement>, StorageError> {
    let mut q = conn
        .prepare_cached(&format!("SELECT {RETAINED_COLUMNS} FROM materialization_retained WHERE displacement_id>?1 ORDER BY displacement_id LIMIT 128"))
        .map_err(StorageError::corrupt)?;
    q.query_map([after], retained_row)
        .map_err(StorageError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt)
}

/// The retained row with `id`, if it is still retained.
pub(crate) fn retained_row_by_id(
    conn: &Connection,
    id: i64,
) -> Result<Option<RetainedDisplacement>, StorageError> {
    use rusqlite::OptionalExtension;
    conn.prepare_cached(&format!(
        "SELECT {RETAINED_COLUMNS} FROM materialization_retained WHERE displacement_id=?1"
    ))
    .map_err(StorageError::corrupt)?
    .query_row([id], retained_row)
    .optional()
    .map_err(StorageError::corrupt)
}

/// How many of a workspace's retained originals the sweep can never release,
/// and their logical size in bytes. Read from the rows alone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetainedSummary {
    pub count: i64,
    pub bytes: i64,
}

pub(crate) fn retained_summary(
    conn: &Connection,
    workspace_id: &str,
) -> Result<RetainedSummary, StorageError> {
    conn.prepare_cached(
        "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM materialization_retained \
         WHERE workspace_id=?1 AND release_blocked IS NOT NULL",
    )
    .map_err(StorageError::corrupt)?
    .query_row([workspace_id], |r| {
        Ok(RetainedSummary {
            count: r.get(0)?,
            bytes: r.get(1)?,
        })
    })
    .map_err(StorageError::corrupt)
}

/// A workspace's retained originals the sweep can never release, oldest
/// first, after `after`, whose quiet period ended by `quiet_before_ms`.
/// Unfinished jobs and holds are the caller's to check.
pub(crate) fn blocked_retained_rows(
    conn: &Connection,
    workspace_id: &str,
    quiet_before_ms: i64,
    after: i64,
    limit: i64,
) -> Result<Vec<RetainedDisplacement>, StorageError> {
    conn.prepare_cached(&format!(
        "SELECT {RETAINED_COLUMNS} FROM materialization_retained \
         WHERE workspace_id=?1 AND release_blocked IS NOT NULL AND changed_at_ms<=?2 \
           AND displacement_id>?3 \
         ORDER BY displacement_id LIMIT ?4"
    ))
    .map_err(StorageError::corrupt)?
    .query_map(
        rusqlite::params![workspace_id, quiet_before_ms, after, limit],
        retained_row,
    )
    .map_err(StorageError::corrupt)?
    .collect::<Result<_, _>>()
    .map_err(StorageError::corrupt)
}

/// Whether recovery may still need `row`'s original: its job has not
/// finished, or an open or kept displacement names the same staged file.
pub(crate) fn retained_original_needed(
    conn: &Connection,
    row: &RetainedDisplacement,
) -> Result<bool, StorageError> {
    let name = row.source_path.rsplit('/').next().unwrap_or_default();
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM materialization_jobs \
             WHERE job_id=?1 AND status='pending') \
         OR EXISTS (SELECT 1 FROM materialization_displacements \
             WHERE job_id=?1 AND displaced_name=?2)",
    )
    .map_err(StorageError::corrupt)?
    .query_row([row.job_id.as_str(), name], |r| r.get(0))
    .map_err(StorageError::corrupt)
}

/// Record whether row `row`'s volume can refuse to unlink an open file, as
/// read from its source's descriptor, unless the row changed since.
pub(crate) fn record_retained_busy_check(
    conn: &Connection,
    row: &RetainedDisplacement,
    unsupported: bool,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE materialization_retained SET release_blocked=?2 \
         WHERE displacement_id=?1 AND device=?3 AND inode=?4 AND digest=?5 AND changed_at_ms=?6",
        rusqlite::params![
            row.displacement_id,
            unsupported.then_some(BUSY_CHECK_UNSUPPORTED),
            row.device,
            row.inode,
            row.digest,
            row.changed_at_ms
        ],
    )
    .map_err(StorageError::persist)?;
    Ok(())
}

pub(crate) fn with_full_commit<T>(
    conn: &Connection,
    f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    crate::durability::with_full_synchronous(conn, |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(StorageError::persist)?;
        let value = f(&tx)?;
        tx.commit().map_err(StorageError::persist)?;
        Ok(value)
    })
}

pub(crate) fn retain(conn: &Connection, row: &RetainedDisplacement) -> Result<i64, StorageError> {
    // A lost row is reconstructed from the staged name during recovery.
    // Keep the ordinary NORMAL commit off the per-save fsync path.
    conn.execute("INSERT INTO materialization_retained(job_id,workspace_id,target_path,source_path,device,inode,digest,size,mtime,ctime,changed_at_ms,release_blocked) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(source_path) DO NOTHING",rusqlite::params![row.job_id,row.workspace_id,row.target_path,row.source_path,row.device,row.inode,row.digest,row.size,row.mtime,row.ctime,row.changed_at_ms,release_blocked(row)]).map_err(StorageError::persist)?;
    conn.query_row(
        "SELECT displacement_id FROM materialization_retained WHERE source_path=?1",
        [&row.source_path],
        |r| r.get(0),
    )
    .map_err(StorageError::corrupt)
}

pub(crate) fn record_retained_read(
    conn: &Connection,
    old: &RetainedDisplacement,
    new: &RetainedDisplacement,
    bytes: &[u8],
    now_ms: i64,
) -> Result<(), StorageError> {
    if crate::hex_sha256(bytes) != new.digest || bytes.len() > crate::MAX_MATERIALIZE_BYTES {
        return Err(StorageError::InvalidInput {
            reason: "retained read bytes do not match the bounded digest",
        });
    }
    // A read version can be overwritten before recovery or source release.
    // FULL keeps those exact bytes even when the staged inode later changes.
    with_full_commit(conn, |tx| {
        let updated=tx.execute("UPDATE materialization_retained SET digest=?2,size=?3,mtime=?4,ctime=?5,changed_at_ms=?6,device=?9,inode=?10,release_blocked=?11 WHERE displacement_id=?1 AND digest=?7 AND changed_at_ms=?8",rusqlite::params![old.displacement_id,new.digest,new.size,new.mtime,new.ctime,now_ms,old.digest,old.changed_at_ms,new.device,new.inode,release_blocked(new)]).map_err(StorageError::persist)?;
        if updated == 1 && new.digest != old.digest {
            tx.execute("INSERT OR IGNORE INTO materialization_displacement_reads(workspace_id,displacement_id,job_id,target_path,sha256,bytes,observed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",rusqlite::params![old.workspace_id,format!("retained:{}",old.displacement_id),old.job_id,old.target_path,new.digest,bytes,now_ms]).map_err(StorageError::persist)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A write that finds its target occupied runs this lookup, so it must
    /// read its index instead of scanning the pending jobs.
    #[test]
    fn pending_merge_delete_lookup_reads_its_index() {
        let dir = dohc_test_scratch::ScratchDir::new_named("pending-merge-deletes").unwrap();
        let store = crate::EngineStore::open(&dir.join("engine.db"), 1).unwrap();
        let details = store
            .read_with(|conn| {
                let mut plan = conn.prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    pending_merge_deletes_sql()
                ))?;
                plan.query_map(["ws", "sha"], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("idx_materialization_jobs_pending_delete_preimage")),
            "{details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.starts_with("SCAN materialization_jobs")),
            "{details:?}"
        );
    }
}
