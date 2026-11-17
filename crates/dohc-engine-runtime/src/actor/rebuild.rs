//! Store reads and writes a joined copy's rebuild needs: the member's work
//! the relay hasn't taken, which blobs a store holds, and the converge waves'
//! materialization jobs, added once by id.

use super::ActorHandle;
use super::materialization::{MaterializationReplayScope, replay_pending_materializations};
use crate::error::RuntimeError;
use dohc_engine_storage::{
    MaterializationJobSpec, NoFaults, Preimage, StorageError, TxnOutcome, enqueue_delete_job,
    enqueue_job,
};
use rusqlite::{OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;

/// How every rebuild job's id starts. Only the rebuild's own waves run these
/// jobs: it plans them against the new store's heads, which an ordinary
/// replay doesn't, so a replay at open leaves them pending.
pub const REBUILD_JOB_PREFIX: &str = "rebuild-";

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

/// The member's work in the old store that the relay hasn't taken.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RebuildUnsent {
    /// Own chat ops past the share's confirmed push position, oldest first:
    /// the op kind and its payload.
    pub chat: Vec<(String, serde_json::Value)>,
    /// The titles of the threads the unsent chat names, by thread id.
    pub thread_titles: BTreeMap<String, String>,
    /// The author and body of each message the unsent chat replies to or
    /// decides on, by message id.
    pub messages: BTreeMap<String, (String, String)>,
    /// Each file whose newest moment is the member's own and writes it: its
    /// path and the hash of its bytes.
    pub versions: Vec<RebuildHead>,
    /// The object ids among `versions` that only the member's own moments
    /// wrote and the relay never accepted a write of: a file they made that
    /// the relay has neither served nor taken.
    pub created: BTreeSet<String>,
    /// Own deletes and moves that are each file's newest moment.
    pub removals: Vec<RebuildRemoval>,
}

/// A file's newest moment that took it away from `path`: a delete, or a move
/// to `moved_to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildRemoval {
    pub path: String,
    pub moved_to: Option<String>,
}

/// The member's own chat state that only their store holds: read markers,
/// bookmarks, follows and feed read state. A rebuild carries it from the old
/// store into the new one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RebuildCarried {
    /// Each table's rows for the workspace, in `CARRIED` order, every column
    /// in the table's own order.
    rows: Vec<Vec<Vec<rusqlite::types::Value>>>,
}

/// Each carried table, with which of its old rows the new store takes: a
/// row whose thread, message, channel or bookmark the new store holds. The
/// rest name what the new reach hides. A follow of a person or an agent and
/// the feed's read position name nothing a reach hides.
const CARRIED: [(&str, &str); 6] = [
    ("chat_thread_read_state", HELD_THREAD),
    ("chat_agent_read_state", HELD_THREAD),
    (
        "chat_bookmarks",
        "EXISTS (SELECT 1 FROM main.chat_threads t WHERE t.workspace_id = c.workspace_id \
         AND t.thread_id = c.thread_id) \
         AND (c.message_id IS NULL OR EXISTS (SELECT 1 FROM main.chat_messages m \
         WHERE m.workspace_id = c.workspace_id AND m.message_id = c.message_id))",
    ),
    (
        "chat_bookmark_outbox",
        "EXISTS (SELECT 1 FROM main.chat_bookmarks b WHERE b.workspace_id = c.workspace_id \
         AND b.bookmark_id = c.bookmark_id)",
    ),
    (
        "chat_follows",
        "c.target_kind IN ('person', 'agent') \
         OR (c.target_kind = 'channel' AND EXISTS (SELECT 1 FROM main.chat_channels h \
         WHERE h.workspace_id = c.workspace_id AND h.channel_id = c.target_id)) \
         OR (c.target_kind = 'thread' AND EXISTS (SELECT 1 FROM main.chat_threads t \
         WHERE t.workspace_id = c.workspace_id AND t.thread_id = c.target_id))",
    ),
    ("chat_feed_read_state", "1"),
];

const HELD_THREAD: &str = "EXISTS (SELECT 1 FROM main.chat_threads t \
         WHERE t.workspace_id = c.workspace_id AND t.thread_id = c.thread_id)";

const OWN_CHAT: &str = "SELECT r.op_kind, r.payload_json FROM replication_log r \
     WHERE r.workspace_id = ?1 AND r.imported = 0 \
     AND r.op_kind IN ('chat.thread.create', 'chat.message.append', 'chat.decision.set', \
       'chat.attachment.add') \
     AND r.origin_seq > COALESCE((SELECT p.pushed_seq FROM shared_channel_push_state p \
       WHERE p.workspace_id = ?1 AND p.share_id = ?2), -1) \
     ORDER BY r.origin_seq";

/// Whether the moment under alias `moment` is one the relay never served
/// back: a share view's pull records each served write as
/// `moment-share-<key>` (`replay_share_write`), and a pull into an ordinary
/// replica logs it as imported.
fn own_moment(moment: &str) -> String {
    format!(
        "{moment}.moment_id NOT LIKE 'moment-share-%' \
         AND {moment}.moment_id NOT IN (SELECT json_extract(r.payload_json, '$.momentId') \
           FROM replication_log r WHERE r.workspace_id = ?1 AND r.imported = 1 \
           AND r.op_kind = 'moment.append' \
           AND json_extract(r.payload_json, '$.momentId') IS NOT NULL)"
    )
}

impl ActorHandle {
    /// The member's work the relay hasn't taken: unsent chat for the share,
    /// and each file whose newest moment is the member's own.
    pub async fn rebuild_unsent(
        &self,
        workspace_id: String,
        share_id: String,
    ) -> Result<RebuildUnsent, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                let corrupt = StorageError::corrupt_public;
                let mut unsent = RebuildUnsent::default();
                let mut statement = conn.prepare(OWN_CHAT).map_err(corrupt)?;
                let rows = statement
                    .query_map(params![workspace_id, share_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(corrupt)?;
                for row in rows {
                    let (kind, payload) = row.map_err(corrupt)?;
                    let payload =
                        serde_json::from_str(&payload).map_err(StorageError::corrupt_public)?;
                    unsent.chat.push((kind, payload));
                }
                let named = |key: &str| -> BTreeSet<String> {
                    unsent
                        .chat
                        .iter()
                        .filter_map(|(_, payload)| payload[key].as_str().map(str::to_owned))
                        .collect()
                };
                let (threads, parents, decided) = (
                    named("threadId"),
                    named("parentMessageId"),
                    named("messageId"),
                );
                for thread in threads {
                    let title: Option<String> = conn
                        .query_row(
                            "SELECT json_extract(payload_json, '$.title') FROM replication_log \
                             WHERE workspace_id = ?1 AND op_kind = 'chat.thread.create' \
                             AND json_extract(payload_json, '$.threadId') = ?2 LIMIT 1",
                            params![workspace_id, thread],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(corrupt)?
                        .flatten();
                    if let Some(title) = title {
                        unsent.thread_titles.insert(thread, title);
                    }
                }
                for message in parents.into_iter().chain(decided) {
                    let found: Option<(Option<String>, Option<String>)> = conn
                        .query_row(
                            "SELECT json_extract(payload_json, '$.authorDisplayName'), \
                             json_extract(payload_json, '$.body') FROM replication_log \
                             WHERE workspace_id = ?1 AND op_kind = 'chat.message.append' \
                             AND json_extract(payload_json, '$.messageId') = ?2 LIMIT 1",
                            params![workspace_id, message],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(corrupt)?;
                    if let Some((Some(author), Some(body))) = found {
                        unsent.messages.insert(message, (author, body));
                    }
                }
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT m.object_id, m.path, m.operation, \
                         COALESCE(m.after_blob_sha256, m.after_binary_sha256), \
                         COALESCE(m.before_path, m.payload_before_path), \
                         NOT EXISTS (SELECT 1 FROM moments x WHERE x.workspace_id = ?1 \
                           AND x.object_id = m.object_id AND NOT ({own_x})) \
                         AND NOT EXISTS (SELECT 1 FROM share_direct_write_marks k \
                           WHERE k.workspace_id = ?1 AND k.share_id = ?2 \
                           AND k.object_id = m.object_id AND k.delivered_through > -1) \
                         FROM moments m WHERE m.workspace_id = ?1 AND {own_m} \
                         AND m.moment_order = (SELECT MAX(o.moment_order) FROM moments o \
                           WHERE o.workspace_id = ?1 AND o.object_id = m.object_id) \
                         ORDER BY m.path",
                        own_x = own_moment("x"),
                        own_m = own_moment("m"),
                    ))
                    .map_err(corrupt)?;
                let rows = statement
                    .query_map(params![workspace_id, share_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, bool>(5)?,
                        ))
                    })
                    .map_err(corrupt)?;
                for row in rows {
                    let (object_id, path, operation, sha256, before_path, created) =
                        row.map_err(corrupt)?;
                    if operation == "delete" {
                        unsent.removals.push(RebuildRemoval {
                            path,
                            moved_to: None,
                        });
                        continue;
                    }
                    if let Some(from) = before_path.filter(|from| *from != path) {
                        unsent.removals.push(RebuildRemoval {
                            path: from,
                            moved_to: Some(path.clone()),
                        });
                    }
                    if let Some(sha256) = sha256 {
                        if created {
                            unsent.created.insert(object_id.clone());
                        }
                        unsent.versions.push(RebuildHead {
                            path,
                            object_id,
                            sha256,
                        });
                    }
                }
                Ok::<_, RuntimeError>(unsent)
            })
        })
        .await
    }

    /// The member's read markers, bookmarks, follows and feed read state.
    pub async fn rebuild_carried(
        &self,
        workspace_id: String,
    ) -> Result<RebuildCarried, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                let corrupt = StorageError::corrupt_public;
                let mut carried = RebuildCarried::default();
                for (table, _) in CARRIED {
                    let mut statement = conn
                        .prepare(&format!("SELECT * FROM {table} WHERE workspace_id = ?1"))
                        .map_err(corrupt)?;
                    let width = statement.column_count();
                    let rows = statement
                        .query_map([&workspace_id], |row| {
                            (0..width).map(|index| row.get(index)).collect()
                        })
                        .map_err(corrupt)?;
                    carried
                        .rows
                        .push(rows.collect::<Result<_, _>>().map_err(corrupt)?);
                }
                Ok::<_, RuntimeError>(carried)
            })
        })
        .await
    }

    /// Write the carried rows the new store takes, in one transaction. A row
    /// the new store already holds keeps its own.
    pub async fn rebuild_carry(&self, carried: RebuildCarried) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            let outcome = store.write_with(&NoFaults, |tx| {
                let corrupt = StorageError::corrupt_public;
                for ((table, held), rows) in CARRIED.iter().zip(&carried.rows) {
                    tx.execute_batch(&format!(
                        "CREATE TEMP TABLE carried AS SELECT * FROM main.{table} WHERE 0"
                    ))
                    .map_err(corrupt)?;
                    for row in rows {
                        let marks = vec!["?"; row.len()].join(", ");
                        tx.execute(
                            &format!("INSERT INTO temp.carried VALUES ({marks})"),
                            rusqlite::params_from_iter(row),
                        )
                        .map_err(corrupt)?;
                    }
                    tx.execute_batch(&format!(
                        "INSERT OR IGNORE INTO main.{table} SELECT * FROM temp.carried c WHERE {held}; \
                         DROP TABLE temp.carried;"
                    ))
                    .map_err(corrupt)?;
                }
                Ok::<_, StorageError>(())
            })?;
            match outcome {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::Storage(
                    StorageError::corrupt_public(std::io::Error::other("rebuild state not carried")),
                )),
            }
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

    /// Run a wave's jobs. The rebuild planned each one against the new
    /// store's heads, so a delete of one spelling runs even where a head at
    /// another spelling reaches the same file, as when an unsent rename by
    /// case alone is undone.
    pub async fn rebuild_run_jobs(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        job_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        #[cfg(unix)]
        self.retained_root.set(root_dir.clone());
        self.run(move |store, _| {
            let selected: HashSet<String> = job_ids.into_iter().collect();
            replay_pending_materializations(
                store,
                &root_dir,
                MaterializationReplayScope {
                    holds: None,
                    workspace_id: &workspace_id,
                    self_writes: None,
                    progress: None,
                    file_outcomes_settled: false,
                    released_hold_paths: None,
                    planned_against_active_heads: true,
                },
                now_ms,
                &NoFaults,
                Some(&selected),
                false,
            )
            .map(|_| ())
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
