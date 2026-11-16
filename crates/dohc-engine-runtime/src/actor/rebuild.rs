//! Store reads and writes a joined copy's rebuild needs: whether the old
//! store holds work of the member's own, which blobs a store holds, and the
//! converge waves' materialization jobs, added once by id.

use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_storage::{
    MaterializationJobSpec, NoFaults, Preimage, StorageError, TxnOutcome, enqueue_delete_job,
    enqueue_job,
};
use rusqlite::{OptionalExtension, params};
use std::collections::{BTreeMap, HashSet};

/// One converge job: write `content_sha256` at the path, or delete the file
/// there. A delete names the bytes it expects as its content and preimage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildJob {
    pub job_id: String,
    pub target_path: String,
    pub delete: bool,
    pub content_sha256: String,
    pub preimage: Option<String>,
    pub target_generation: i64,
}

/// A current file on the store's main version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildHead {
    pub path: String,
    pub object_id: String,
    pub sha256: String,
}

/// Each query names one kind of own work, so the answer says what kept the
/// copy closed. A kind is listed when any row matches.
const OWN_WORK: &[(&str, &str)] = &[
    // A moment the relay never served back: the member's edit, captured or
    // made through dohc, sent or not. A share view's pull records each
    // served write as `moment-share-<key>` (`replay_share_write`); a pull
    // into an ordinary replica logs it as imported.
    (
        "moments",
        "SELECT EXISTS (SELECT 1 FROM moments m WHERE m.workspace_id = ?1 \
         AND m.moment_id NOT LIKE 'moment-share-%' \
         AND m.moment_id NOT IN (SELECT json_extract(r.payload_json, '$.momentId') \
           FROM replication_log r WHERE r.workspace_id = ?1 AND r.imported = 1 \
           AND r.op_kind = 'moment.append' \
           AND json_extract(r.payload_json, '$.momentId') IS NOT NULL))",
    ),
    // An op of this copy's own origin, other than chat the relay already took.
    (
        "unsent changes",
        "SELECT EXISTS (SELECT 1 FROM replication_log r WHERE r.workspace_id = ?1 \
         AND r.imported = 0 AND NOT (r.op_kind LIKE 'chat.%' AND r.origin_seq <= \
           COALESCE((SELECT MAX(p.pushed_seq) FROM shared_channel_push_state p \
             WHERE p.workspace_id = ?1), -1)))",
    ),
    (
        "refused changes",
        "SELECT EXISTS (SELECT 1 FROM replication_pending_refusals WHERE workspace_id = ?1)",
    ),
    (
        "conflicts",
        "SELECT EXISTS (SELECT 1 FROM conflicts WHERE workspace_id = ?1)",
    ),
    (
        "unfinished file writes",
        "SELECT EXISTS (SELECT 1 FROM materialization_jobs WHERE workspace_id = ?1 \
         AND status IN ('pending', 'conflict'))",
    ),
    (
        "displaced files",
        "SELECT EXISTS (SELECT 1 FROM materialization_displacements WHERE workspace_id = ?1)",
    ),
    (
        "direct writes",
        "SELECT EXISTS (SELECT 1 FROM share_direct_write_plan WHERE workspace_id = ?1) \
         OR EXISTS (SELECT 1 FROM share_direct_write_marks WHERE workspace_id = ?1)",
    ),
];

impl ActorHandle {
    /// The kinds of own work the store holds, empty when it holds none. A
    /// copy that holds any is not rebuilt by dropping its store.
    pub async fn rebuild_own_work(
        &self,
        workspace_id: String,
    ) -> Result<Vec<String>, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                let mut kinds = Vec::new();
                for (kind, query) in OWN_WORK {
                    let held: bool = conn
                        .query_row(query, [&workspace_id], |row| row.get(0))
                        .map_err(StorageError::corrupt_public)?;
                    if held {
                        kinds.push((*kind).to_owned());
                    }
                }
                Ok::<_, RuntimeError>(kinds)
            })
        })
        .await
    }

    /// Every current file on the workspace's main version, by path.
    pub async fn rebuild_main_heads(
        &self,
        workspace_id: String,
    ) -> Result<Vec<RebuildHead>, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT s.path, s.object_id, CASE COALESCE(s.content_kind, 'text')                            WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END                          FROM snapshots s JOIN versioned_workspaces w                            ON w.workspace_id = s.workspace_id AND w.main_version_id = s.version_id                          WHERE s.workspace_id = ?1 ORDER BY s.path",
                    )
                    .map_err(StorageError::corrupt_public)?;
                let rows = statement
                    .query_map([&workspace_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
                    })
                    .map_err(StorageError::corrupt_public)?;
                let mut heads = Vec::new();
                for row in rows {
                    let (path, object_id, sha256) = row.map_err(StorageError::corrupt_public)?;
                    if let Some(sha256) = sha256 {
                        heads.push(RebuildHead { path, object_id, sha256 });
                    }
                }
                Ok::<_, RuntimeError>(heads)
            })
        })
        .await
    }

    /// Remove the empty folder at `path` so a file can take its name.
    pub async fn rebuild_remove_empty_folder(
        &self,
        root: std::path::PathBuf,
        path: String,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            dohc_engine_files::remove_empty_directory_target(store, &root, &path)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// The hashes among `hashes` whose bytes the store holds.
    pub async fn rebuild_held_blobs(
        &self,
        hashes: Vec<String>,
    ) -> Result<HashSet<String>, RuntimeError> {
        self.run(move |store, _| {
            let mut held = HashSet::new();
            for sha in hashes {
                if store.get_materialization_blob(&sha)?.is_some() {
                    held.insert(sha);
                }
            }
            Ok(held)
        })
        .await
    }

    /// Add a wave's jobs in one transaction. A job whose id the ledger
    /// already holds is skipped, so a restart never adds it twice.
    pub async fn rebuild_add_jobs(
        &self,
        workspace_id: String,
        jobs: Vec<RebuildJob>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            let outcome = store.write_with(&NoFaults, |tx| {
                for job in &jobs {
                    let added = tx
                        .query_row(
                            "SELECT 1 FROM materialization_jobs WHERE job_id = ?1",
                            params![job.job_id],
                            |_| Ok(()),
                        )
                        .optional()
                        .map_err(StorageError::corrupt_public)?;
                    if added.is_some() {
                        continue;
                    }
                    let spec = MaterializationJobSpec {
                        job_id: job.job_id.clone(),
                        workspace_id: workspace_id.clone(),
                        target_path: job.target_path.clone(),
                        content_sha256: job.content_sha256.clone(),
                        preimage: match &job.preimage {
                            None => Preimage::Absent,
                            Some(sha) => Preimage::Present(sha.clone()),
                        },
                        target_generation: job.target_generation,
                        now_ms,
                    };
                    if job.delete {
                        enqueue_delete_job(tx, &spec)?;
                    } else {
                        enqueue_job(tx, &spec)?;
                    }
                }
                Ok::<_, StorageError>(())
            })?;
            match outcome {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::Storage(
                    StorageError::corrupt_public(std::io::Error::other("rebuild jobs not added")),
                )),
            }
        })
        .await
    }

    /// Each named job's status (`pending`, `complete`, `conflict` or
    /// `cancelled`); a job the ledger doesn't hold is left out.
    pub async fn rebuild_job_statuses(
        &self,
        job_ids: Vec<String>,
    ) -> Result<BTreeMap<String, String>, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                let mut statuses = BTreeMap::new();
                for id in job_ids {
                    let status: Option<String> = conn
                        .query_row(
                            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
                            params![id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(StorageError::corrupt_public)?;
                    if let Some(status) = status {
                        statuses.insert(id, status);
                    }
                }
                Ok::<_, RuntimeError>(statuses)
            })
        })
        .await
    }
}
