//! What a pass owes for queued Y.Doc rows its drains removed before the pass
//! reached its reporting boundary. The transaction that deletes a row writes
//! its report, keyed by the row's coordinate, so a pass that waits later, is
//! abandoned, or meets a restart loses nothing it committed. The pass claims
//! every report no other live pass owns under its settlement report token,
//! and its cursor commit removes them, as it does its applied settlements.
//! A report keeps the refusals its drain persisted too: a projection that
//! settles their lineage clears their notices, and with them the pending
//! refusals a pass would otherwise report.

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use dohc_engine_domain::CollectionRecordApplyFacts;
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};

use crate::{MomentMaterializationChange, ReplicationRefusal, SharingDeclined, SyncError};

/// What a drain reported as a whole, not of one row: conflicts its bases
/// opened, sharing its projection declined, the files it changed, and the
/// refusals it persisted. It rides with the drain's last removed row.
#[derive(Debug, Default)]
pub(crate) struct DrainExtras {
    pub(crate) conflicts_opened: i64,
    pub(crate) sharing_declined: Vec<SharingDeclined>,
    pub(crate) changes: Vec<MomentMaterializationChange>,
    pub(crate) refusals: Vec<ReplicationRefusal>,
}

impl DrainExtras {
    fn is_empty(&self) -> bool {
        self.conflicts_opened == 0
            && self.sharing_declined.is_empty()
            && self.changes.is_empty()
            && self.refusals.is_empty()
    }
}

/// What every report a pass claimed adds up to.
#[derive(Debug, Default)]
pub(crate) struct ClaimedReports {
    pub(crate) record_facts: Vec<CollectionRecordApplyFacts>,
    pub(crate) extras: DrainExtras,
}

impl ClaimedReports {
    /// Add `report`, a report of `workspace_id`, whole or not at all.
    fn add(&mut self, workspace_id: &str, report: StoredReport) -> Result<(), SyncError> {
        let conflicts_opened = self
            .extras
            .conflicts_opened
            .checked_add(report.conflicts_opened)
            .ok_or_else(malformed)?;
        let sharing_declined = report
            .sharing_declined
            .into_iter()
            .map(StoredDecline::declined)
            .collect::<Result<Vec<_>, _>>()?;
        let changes = report
            .changes
            .into_iter()
            .map(StoredChange::change)
            .collect::<Result<Vec<_>, _>>()?;
        self.record_facts.extend(report.record_facts);
        self.extras.conflicts_opened = conflicts_opened;
        self.extras.sharing_declined.extend(sharing_declined);
        self.extras.changes.extend(changes);
        self.extras.refusals.extend(
            report
                .refusals
                .into_iter()
                .map(|refusal| refusal.refusal(workspace_id)),
        );
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record_facts: Option<CollectionRecordApplyFacts>,
    #[serde(default)]
    conflicts_opened: i64,
    #[serde(default)]
    sharing_declined: Vec<StoredDecline>,
    #[serde(default)]
    changes: Vec<StoredChange>,
    #[serde(default)]
    refusals: Vec<StoredRefusal>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDecline {
    object_id: String,
    version_id: String,
    lineage_pruned: bool,
    head_blob_sha256: Option<String>,
    path: String,
    constraint: String,
    limit_bytes: usize,
    observed_bytes: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChange {
    version_id: String,
    path: String,
    operation: String,
    content_kind: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRefusal {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    reason: String,
}

fn malformed() -> SyncError {
    crate::error::local_corruption("a drain report is malformed")
}

impl StoredDecline {
    fn new(declined: &SharingDeclined) -> Self {
        Self {
            object_id: declined.object_id.clone(),
            version_id: declined.version_id.clone(),
            lineage_pruned: declined.lineage_pruned,
            head_blob_sha256: declined.head_blob_sha256.clone(),
            path: declined.path.clone(),
            constraint: declined.constraint.to_owned(),
            limit_bytes: declined.limit_bytes,
            observed_bytes: declined.observed_bytes,
        }
    }

    fn declined(self) -> Result<SharingDeclined, SyncError> {
        Ok(SharingDeclined {
            object_id: self.object_id,
            version_id: self.version_id,
            lineage_pruned: self.lineage_pruned,
            head_blob_sha256: self.head_blob_sha256,
            path: self.path,
            constraint: match self.constraint.as_str() {
                "MAX_YDOC_UPDATE_BYTES" => "MAX_YDOC_UPDATE_BYTES",
                _ => return Err(malformed()),
            },
            limit_bytes: self.limit_bytes,
            observed_bytes: self.observed_bytes,
        })
    }
}

impl StoredChange {
    fn new(change: &MomentMaterializationChange) -> Self {
        Self {
            version_id: change.version_id.clone(),
            path: change.path.clone(),
            operation: change.operation.to_owned(),
            content_kind: change.content_kind.to_owned(),
        }
    }

    fn change(self) -> Result<MomentMaterializationChange, SyncError> {
        Ok(MomentMaterializationChange {
            version_id: self.version_id,
            path: self.path,
            operation: match self.operation.as_str() {
                "write" => "write",
                "delete" => "delete",
                _ => return Err(malformed()),
            },
            content_kind: match self.content_kind.as_str() {
                "text" => "text",
                "binary" => "binary",
                "secret" => "secret",
                _ => return Err(malformed()),
            },
        })
    }
}

impl StoredRefusal {
    fn new(refusal: &ReplicationRefusal) -> Self {
        Self {
            origin_id: refusal.origin_id.clone(),
            origin_seq: refusal.origin_seq,
            op_kind: refusal.op_kind.clone(),
            reason: refusal.reason.message().to_owned(),
        }
    }

    fn refusal(self, workspace_id: &str) -> ReplicationRefusal {
        ReplicationRefusal {
            workspace_id: workspace_id.to_owned(),
            origin_id: self.origin_id,
            origin_seq: self.origin_seq,
            op_kind: self.op_kind,
            reason: crate::RefusalReason::InvalidInput {
                reason: self.reason,
            },
        }
    }
}

/// Write the report each of `coordinates`, queued rows of `workspace_id`
/// this transaction removes, owes: the facts it parked, and for the last
/// one `extras`. Runs before the rows go. A row that owes nothing writes
/// nothing.
pub(crate) fn record_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    coordinates: &[(String, i64)],
    extras: &DrainExtras,
) -> Result<(), SyncError> {
    for (index, (origin_id, origin_seq)) in coordinates.iter().enumerate() {
        let facts: Option<String> = tx
            .query_row(
                "SELECT record_facts_json FROM ydoc_deferred_updates \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace_id, origin_id, origin_seq],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?
            .flatten();
        let last = index + 1 == coordinates.len();
        let report = StoredReport {
            record_facts: facts
                .as_deref()
                .map(crate::ydoc_apply::parse_parked_record_facts)
                .transpose()?,
            conflicts_opened: if last { extras.conflicts_opened } else { 0 },
            sharing_declined: if last {
                extras
                    .sharing_declined
                    .iter()
                    .map(StoredDecline::new)
                    .collect()
            } else {
                Vec::new()
            },
            changes: if last {
                extras.changes.iter().map(StoredChange::new).collect()
            } else {
                Vec::new()
            },
            refusals: if last {
                extras.refusals.iter().map(StoredRefusal::new).collect()
            } else {
                Vec::new()
            },
        };
        if report.record_facts.is_none() && (!last || extras.is_empty()) {
            continue;
        }
        tx.execute(
            "INSERT INTO ydoc_drain_reports \
             (workspace_id,origin_id,origin_seq,report_json,report_id) VALUES (?1,?2,?3,?4,NULL)",
            params![
                workspace_id,
                origin_id,
                origin_seq,
                serde_json::to_string(&report).map_err(SyncError::corrupt)?
            ],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

/// Claim every drain report of `workspace_id` that `report_id` does not
/// already own under it, creating the token when none exists yet, and answer
/// what they report. One an abandoned pass claimed is claimed again. A report
/// this build cannot read is removed as the rest are claimed, and the claim
/// then fails once, so the pass that meets it says so and the next one
/// reports the rest.
pub(crate) fn claim(
    store: &mut EngineStore,
    workspace_id: &str,
    report_id: &mut Option<String>,
    faults: &dyn FaultInjector,
) -> Result<ClaimedReports, SyncError> {
    let pending: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_drain_reports \
             WHERE workspace_id=?1 AND COALESCE(report_id!=?2,1))",
            params![workspace_id, report_id.as_deref()],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    if !pending {
        return Ok(ClaimedReports::default());
    }
    let outcome = store.write_with(faults, |tx| {
        let token = match report_id.as_ref() {
            Some(token) => token.clone(),
            None => tx
                .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
                .map_err(SyncError::corrupt)?,
        };
        let mut statement = tx
            .prepare(
                "UPDATE ydoc_drain_reports SET report_id=?2 \
                 WHERE workspace_id=?1 AND COALESCE(report_id!=?2,1) \
                 RETURNING rowid,origin_id,origin_seq,report_json",
            )
            .map_err(SyncError::corrupt)?;
        let mut rows = statement
            .query_map(params![workspace_id, token], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::persist)?;
        // In the order the drains removed their rows.
        rows.sort_by_key(|(rowid, ..)| *rowid);
        drop(statement);
        let mut claimed = ClaimedReports::default();
        let mut unreadable = false;
        for (_, origin_id, origin_seq, json) in rows {
            let added = serde_json::from_str::<StoredReport>(&json)
                .map_err(|_| malformed())
                .and_then(|report| claimed.add(workspace_id, report));
            if added.is_err() {
                tx.execute(
                    "DELETE FROM ydoc_drain_reports \
                     WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                    params![workspace_id, origin_id, origin_seq],
                )
                .map_err(SyncError::persist)?;
                unreadable = true;
            }
        }
        Ok::<_, SyncError>((token, claimed, unreadable))
    })?;
    let TxnOutcome::Committed((token, claimed, unreadable)) = outcome else {
        return Err(SyncError::FaultCrash);
    };
    *report_id = Some(token);
    if unreadable {
        return Err(malformed());
    }
    Ok(claimed)
}

/// Remove the reports a committed pass claimed under `report_id`.
pub(crate) fn release_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    report_id: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "DELETE FROM ydoc_drain_reports WHERE workspace_id=?1 AND report_id=?2",
        params![workspace_id, report_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
