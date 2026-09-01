//! Durable owner-authored Y.Doc delivery queue.
//!
//! This queue is intentionally separate from the ordinary Y.Doc update log,
//! replication, settlement, and materialization. It retains an immutable live
//! object binding plus a base update until a configured service host returns a
//! durable receipt for each ordered update.

use dohc_engine_domain::validate_addressable_plaintext_path;
use dohc_engine_storage::{
    get_binary_blob, hex_sha256, put_binary_blob_with_sha, EngineStore, NoFaults, StorageError,
    TxnOutcome, MAX_IDENTIFIER_BYTES,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, thiserror::Error)]
pub enum OwnerOutboxError {
    #[error("owner Y.Doc outbox input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("owner Y.Doc outbox workspace does not match the engine handle")]
    WorkspaceMismatch,
    #[error("owner Y.Doc outbox immutable binding or base changed")]
    ParentMismatch,
    #[error("owner Y.Doc outbox append key was reused with different input")]
    AppendKeyMismatch,
    #[error("owner Y.Doc outbox is frozen for recovery")]
    Frozen,
    #[error("owner Y.Doc outbox was not found")]
    NotFound,
    #[error("owner Y.Doc outbox receipt does not match the pending prefix")]
    ReceiptMismatch,
    #[error("owner Y.Doc outbox state is corrupt")]
    Corrupt,
    #[error(transparent)]
    Storage(#[from] StorageError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveObjectBinding {
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
    pub current_path: String,
    pub selector_paths: Vec<String>,
    pub restore_fence_generation: i64,
}

impl LiveObjectBinding {
    fn normalized(mut self) -> Result<Self, OwnerOutboxError> {
        for value in [
            self.workspace_id.as_str(),
            self.main_version_id.as_str(),
            self.object_id.as_str(),
            self.lineage_claim_id.as_str(),
        ] {
            if value.is_empty()
                || value.len() > MAX_IDENTIFIER_BYTES
                || value.bytes().any(|byte| byte.is_ascii_control())
            {
                return Err(OwnerOutboxError::InvalidInput(
                    "binding identifiers must be non-empty, bounded, and contain no control bytes",
                ));
            }
        }
        if self.restore_fence_generation < 0 {
            return Err(OwnerOutboxError::InvalidInput(
                "restore fence generation must be non-negative",
            ));
        }
        self.current_path = normalize_path(&self.current_path)?;
        self.selector_paths = self
            .selector_paths
            .iter()
            .map(|path| normalize_path(path))
            .collect::<Result<Vec<_>, _>>()?;
        self.selector_paths.sort();
        self.selector_paths.dedup();
        if self.selector_paths.is_empty() {
            return Err(OwnerOutboxError::InvalidInput(
                "selector paths must not be empty",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct OwnerOutboxLimits {
    pub max_pending_bytes: i64,
    pub max_pending_age_ms: i64,
}

impl OwnerOutboxLimits {
    fn validate(&self) -> Result<(), OwnerOutboxError> {
        if self.max_pending_bytes <= 0 || self.max_pending_age_ms <= 0 {
            return Err(OwnerOutboxError::InvalidInput(
                "outbox limits must be finite positive wire integers",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct OwnerOutboxAppendInput {
    pub binding: LiveObjectBinding,
    pub base_update: Vec<u8>,
    pub append_key: String,
    pub update: Vec<u8>,
    pub limits: OwnerOutboxLimits,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOutboxAppendResult {
    pub outbox_id: String,
    pub sequence: i64,
    pub delivery_id: String,
    pub update_digest: String,
    pub pending_bytes: i64,
    pub oldest_entry_at_ms: i64,
    pub state: OwnerOutboxState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerOutboxState {
    Active,
    Sealed,
    Quarantined,
}

impl OwnerOutboxState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Sealed => "sealed",
            Self::Quarantined => "quarantined",
        }
    }

    fn parse(value: &str) -> Result<Self, OwnerOutboxError> {
        match value {
            "active" => Ok(Self::Active),
            "sealed" => Ok(Self::Sealed),
            "quarantined" => Ok(Self::Quarantined),
            _ => Err(OwnerOutboxError::Corrupt),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOutboxEntry {
    pub sequence: i64,
    pub append_key: String,
    pub delivery_id: String,
    pub update_digest: String,
    pub update: Vec<u8>,
    pub byte_length: i64,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOutboxPending {
    pub outbox_id: String,
    pub binding: LiveObjectBinding,
    pub base_update_digest: String,
    pub base_update: Vec<u8>,
    pub state: OwnerOutboxState,
    pub pending_bytes: i64,
    pub oldest_entry_at_ms: Option<i64>,
    pub entries: Vec<OwnerOutboxEntry>,
    pub quarantine_reason: Option<String>,
    pub observed_binding: Option<LiveObjectBinding>,
}

#[derive(Debug, Clone)]
pub struct OwnerDeliveryReceipt {
    pub delivery_id: String,
    pub update_digest: String,
    pub journal_cursor: i64,
    pub accepting_host_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOutboxAcknowledgeResult {
    pub acknowledged: i64,
    pub pending_bytes: i64,
    pub oldest_entry_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct OwnerOutboxQuarantineInput {
    pub outbox_id: String,
    pub reason: String,
    pub observed_binding: Option<LiveObjectBinding>,
}

#[derive(Debug)]
struct ParentRow {
    outbox_id: String,
    binding: LiveObjectBinding,
    base_update_digest: String,
    base_blob_digest: String,
    state: OwnerOutboxState,
    pending_bytes: i64,
    oldest_entry_at_ms: Option<i64>,
    next_sequence: i64,
    quarantine_reason: Option<String>,
    observed_binding: Option<LiveObjectBinding>,
}

pub fn append(
    store: &mut EngineStore,
    workspace_id: &str,
    input: OwnerOutboxAppendInput,
) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
    let binding = input.binding.normalized()?;
    require_workspace(workspace_id, &binding.workspace_id)?;
    input.limits.validate()?;
    validate_identifier(
        &input.append_key,
        "append key must be non-empty and bounded",
    )?;
    if input.base_update.is_empty() || input.update.is_empty() {
        return Err(OwnerOutboxError::InvalidInput(
            "base and update bytes must not be empty",
        ));
    }
    if input.created_at_ms < 0 {
        return Err(OwnerOutboxError::InvalidInput(
            "creation time must be non-negative",
        ));
    }

    let base_update_digest = hex_sha256(&input.base_update);
    let update_digest = hex_sha256(&input.update);
    let binding_json = binding_json(&binding)?;
    let outbox_id = outbox_id(&binding, &base_update_digest, &binding_json);

    let outcome = store.write_with(&NoFaults, |tx| {
        if let Some((
            existing_outbox_id,
            sequence,
            delivery_id,
            existing_update_digest,
            result_pending_bytes,
            result_oldest_entry_at_ms,
            result_state,
        )) = tx
            .query_row(
                "SELECT outbox_id,sequence,delivery_id,update_digest,result_pending_bytes,\
                 result_oldest_entry_at_ms,result_state \
                 FROM owner_ydoc_outbox_entries WHERE append_key=?1",
                [&input.append_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(read_sql)?
        {
            let parent = read_parent(tx, &existing_outbox_id)?.ok_or(OwnerOutboxError::Corrupt)?;
            if parent.binding != binding
                || parent.base_update_digest != base_update_digest
                || existing_update_digest != update_digest
            {
                return Err(OwnerOutboxError::AppendKeyMismatch);
            }
            return Ok(OwnerOutboxAppendResult {
                outbox_id: parent.outbox_id,
                sequence,
                delivery_id,
                update_digest: existing_update_digest,
                pending_bytes: result_pending_bytes,
                oldest_entry_at_ms: result_oldest_entry_at_ms,
                state: OwnerOutboxState::parse(&result_state)?,
            });
        }

        let parent = find_parent_for_binding(tx, &binding)?;
        let parent = match parent {
            Some(parent) => {
                if parent.binding != binding || parent.base_update_digest != base_update_digest {
                    return Err(OwnerOutboxError::ParentMismatch);
                }
                parent
            }
            None => {
                put_binary_blob_with_sha(tx, &input.base_update, &base_update_digest)?;
                tx.execute(
                    "INSERT INTO owner_ydoc_outboxes \
                     (outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,\
                      current_path,selector_paths_json,restore_fence_generation,\
                      base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,\
                      oldest_entry_at_ms,next_sequence,quarantine_reason,observed_binding_json,created_at_ms) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,'active',0,NULL,1,NULL,NULL,?11)",
                    params![
                        outbox_id,
                        binding.workspace_id,
                        binding.main_version_id,
                        binding.object_id,
                        binding.lineage_claim_id,
                        binding.current_path,
                        serde_json::to_string(&binding.selector_paths)
                            .map_err(|_| OwnerOutboxError::InvalidInput("selector paths are not serializable"))?,
                        binding.restore_fence_generation,
                        base_update_digest,
                        i64::try_from(input.base_update.len()).map_err(|_| OwnerOutboxError::InvalidInput("base update is too large"))?,
                        input.created_at_ms,
                    ],
                )
                .map_err(write_sql)?;
                read_parent(tx, &outbox_id)?.ok_or(OwnerOutboxError::Corrupt)?
            }
        };

        if parent.state != OwnerOutboxState::Active {
            return Err(OwnerOutboxError::Frozen);
        }
        let byte_length = i64::try_from(input.update.len())
            .map_err(|_| OwnerOutboxError::InvalidInput("update is too large"))?;
        let pending_bytes = parent
            .pending_bytes
            .checked_add(byte_length)
            .ok_or(OwnerOutboxError::InvalidInput("pending byte count overflow"))?;
        let oldest_entry_at_ms = parent.oldest_entry_at_ms.unwrap_or(input.created_at_ms);
        let age_ms = input.created_at_ms.saturating_sub(oldest_entry_at_ms);
        let next_state = if pending_bytes >= input.limits.max_pending_bytes
            || age_ms >= input.limits.max_pending_age_ms
        {
            OwnerOutboxState::Sealed
        } else {
            OwnerOutboxState::Active
        };
        let delivery_id = delivery_id(&parent.outbox_id, parent.next_sequence, &update_digest);
        put_binary_blob_with_sha(tx, &input.update, &update_digest)?;
        tx.execute(
            "INSERT INTO owner_ydoc_outbox_entries \
             (outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,\
              byte_length,created_at_ms,pending,result_pending_bytes,\
              result_oldest_entry_at_ms,result_state) \
             VALUES (?1,?2,?3,?4,?5,?5,?6,?7,1,?8,?9,?10)",
            params![
                parent.outbox_id,
                parent.next_sequence,
                input.append_key,
                delivery_id,
                update_digest,
                byte_length,
                input.created_at_ms,
                pending_bytes,
                oldest_entry_at_ms,
                next_state.as_str(),
            ],
        )
        .map_err(write_sql)?;
        tx.execute(
            "UPDATE owner_ydoc_outboxes SET pending_bytes=?2,oldest_entry_at_ms=?3,\
             next_sequence=?4,state=?5 WHERE outbox_id=?1",
            params![
                parent.outbox_id,
                pending_bytes,
                oldest_entry_at_ms,
                parent.next_sequence + 1,
                next_state.as_str(),
            ],
        )
        .map_err(write_sql)?;

        Ok(OwnerOutboxAppendResult {
            outbox_id: parent.outbox_id,
            sequence: parent.next_sequence,
            delivery_id,
            update_digest,
            pending_bytes,
            oldest_entry_at_ms,
            state: next_state,
        })
    })?;
    committed(outcome)
}

pub fn read_pending(
    store: &EngineStore,
    workspace_id: &str,
    outbox_id: &str,
) -> Result<OwnerOutboxPending, OwnerOutboxError> {
    validate_identifier(outbox_id, "outbox id must be non-empty and bounded")?;
    store.read_with(|conn| {
        let parent = read_parent(conn, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        let base_update =
            get_binary_blob(conn, &parent.base_blob_digest)?.ok_or(OwnerOutboxError::Corrupt)?;
        if hex_sha256(&base_update) != parent.base_update_digest {
            return Err(OwnerOutboxError::Corrupt);
        }
        let mut statement = conn
            .prepare(
                "SELECT sequence,append_key,delivery_id,update_digest,update_blob_digest,\
                 byte_length,created_at_ms FROM owner_ydoc_outbox_entries \
                 WHERE outbox_id=?1 AND pending=1 ORDER BY sequence",
            )
            .map_err(read_sql)?;
        let rows = statement
            .query_map([outbox_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(read_sql)?;
        let mut entries = Vec::new();
        for row in rows {
            let (
                sequence,
                append_key,
                delivery_id,
                update_digest,
                blob_digest,
                byte_length,
                created_at_ms,
            ) = row.map_err(read_sql)?;
            let update = get_binary_blob(conn, &blob_digest)?.ok_or(OwnerOutboxError::Corrupt)?;
            if update_digest != blob_digest
                || hex_sha256(&update) != update_digest
                || i64::try_from(update.len()).ok() != Some(byte_length)
            {
                return Err(OwnerOutboxError::Corrupt);
            }
            entries.push(OwnerOutboxEntry {
                sequence,
                append_key,
                delivery_id,
                update_digest,
                update,
                byte_length,
                created_at_ms,
            });
        }
        Ok(OwnerOutboxPending {
            outbox_id: parent.outbox_id,
            binding: parent.binding,
            base_update_digest: parent.base_update_digest,
            base_update,
            state: parent.state,
            pending_bytes: parent.pending_bytes,
            oldest_entry_at_ms: parent.oldest_entry_at_ms,
            entries,
            quarantine_reason: parent.quarantine_reason,
            observed_binding: parent.observed_binding,
        })
    })
}

pub fn acknowledge(
    store: &mut EngineStore,
    workspace_id: &str,
    outbox_id: &str,
    receipts: &[OwnerDeliveryReceipt],
) -> Result<OwnerOutboxAcknowledgeResult, OwnerOutboxError> {
    validate_identifier(outbox_id, "outbox id must be non-empty and bounded")?;
    if receipts.is_empty() {
        return Err(OwnerOutboxError::InvalidInput("receipts must not be empty"));
    }
    for receipt in receipts {
        validate_identifier(
            &receipt.delivery_id,
            "delivery id must be non-empty and bounded",
        )?;
        validate_digest(&receipt.update_digest)?;
        validate_identifier(
            &receipt.accepting_host_epoch,
            "accepting host epoch must be non-empty and bounded",
        )?;
        if receipt.journal_cursor < 0 {
            return Err(OwnerOutboxError::InvalidInput(
                "journal cursor must be non-negative",
            ));
        }
    }

    let outcome = store.write_with(&NoFaults, |tx| {
        let parent = read_parent(tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        if parent.state != OwnerOutboxState::Active {
            return Err(OwnerOutboxError::Frozen);
        }
        let mut statement = tx
            .prepare(
                "SELECT sequence,delivery_id,update_digest,byte_length \
                 FROM owner_ydoc_outbox_entries \
                 WHERE outbox_id=?1 AND pending=1 ORDER BY sequence",
            )
            .map_err(read_sql)?;
        let rows = statement
            .query_map([outbox_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?))
            })
            .map_err(read_sql)?;
        let prefix = rows
            .take(receipts.len())
            .collect::<Result<Vec<_>, _>>()
            .map_err(read_sql)?;
        if prefix.len() != receipts.len()
            || prefix.iter().zip(receipts).any(|((_, delivery_id, digest, _), receipt)| {
                delivery_id != &receipt.delivery_id || digest != &receipt.update_digest
            })
        {
            return Err(OwnerOutboxError::ReceiptMismatch);
        }
        let acknowledged_bytes = prefix.iter().try_fold(0_i64, |total, row| {
            total.checked_add(row.3).ok_or(OwnerOutboxError::Corrupt)
        })?;
        let last_sequence = prefix.last().ok_or(OwnerOutboxError::ReceiptMismatch)?.0;
        let released_digests = prefix
            .iter()
            .map(|(_, _, digest, _)| digest.clone())
            .collect::<BTreeSet<_>>();
        let acknowledged = tx
            .execute(
                "UPDATE owner_ydoc_outbox_entries SET pending=0,update_blob_digest=NULL \
                 WHERE outbox_id=?1 AND pending=1 AND sequence<=?2",
                params![outbox_id, last_sequence],
            )
            .map_err(write_sql)?;
        if acknowledged != receipts.len() {
            return Err(OwnerOutboxError::Corrupt);
        }
        for digest in released_digests {
            delete_binary_blob_if_unreferenced(tx, &digest)?;
        }
        let pending_bytes = parent
            .pending_bytes
            .checked_sub(acknowledged_bytes)
            .filter(|value| *value >= 0)
            .ok_or(OwnerOutboxError::Corrupt)?;
        let oldest_entry_at_ms = tx
            .query_row(
                "SELECT MIN(created_at_ms) FROM owner_ydoc_outbox_entries \
                 WHERE outbox_id=?1 AND pending=1",
                [outbox_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(read_sql)?;
        tx.execute(
            "UPDATE owner_ydoc_outboxes SET pending_bytes=?2,oldest_entry_at_ms=?3 WHERE outbox_id=?1",
            params![outbox_id, pending_bytes, oldest_entry_at_ms],
        )
        .map_err(write_sql)?;
        Ok(OwnerOutboxAcknowledgeResult {
            acknowledged: i64::try_from(receipts.len())
                .map_err(|_| OwnerOutboxError::InvalidInput("too many receipts"))?,
            pending_bytes,
            oldest_entry_at_ms,
        })
    })?;
    committed(outcome)
}

pub fn quarantine(
    store: &mut EngineStore,
    workspace_id: &str,
    input: OwnerOutboxQuarantineInput,
) -> Result<(), OwnerOutboxError> {
    validate_identifier(&input.outbox_id, "outbox id must be non-empty and bounded")?;
    validate_identifier(
        &input.reason,
        "quarantine reason must be non-empty and bounded",
    )?;
    let observed_binding = input
        .observed_binding
        .map(LiveObjectBinding::normalized)
        .transpose()?;
    let observed_binding_json = observed_binding.as_ref().map(binding_json).transpose()?;
    let outcome = store.write_with(&NoFaults, |tx| {
        let parent = read_parent(tx, &input.outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        tx.execute(
            "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason=?2,\
             observed_binding_json=?3 WHERE outbox_id=?1",
            params![input.outbox_id, input.reason, observed_binding_json],
        )
        .map_err(write_sql)?;
        Ok::<(), OwnerOutboxError>(())
    })?;
    committed(outcome)
}

fn read_parent(conn: &Connection, outbox_id: &str) -> Result<Option<ParentRow>, OwnerOutboxError> {
    conn.query_row(
        "SELECT outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,\
         current_path,selector_paths_json,restore_fence_generation,base_update_digest,\
         base_blob_digest,state,pending_bytes,oldest_entry_at_ms,next_sequence,\
         quarantine_reason,observed_binding_json \
         FROM owner_ydoc_outboxes WHERE outbox_id=?1",
        [outbox_id],
        parent_from_row,
    )
    .optional()
    .map_err(read_sql)
}

fn find_parent_for_binding(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<ParentRow>, OwnerOutboxError> {
    conn.query_row(
        "SELECT outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,\
         current_path,selector_paths_json,restore_fence_generation,base_update_digest,\
         base_blob_digest,state,pending_bytes,oldest_entry_at_ms,next_sequence,\
         quarantine_reason,observed_binding_json \
         FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 \
         AND object_id=?3 AND lineage_claim_id=?4",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
        ],
        parent_from_row,
    )
    .optional()
    .map_err(read_sql)
}

fn parent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ParentRow> {
    let selector_paths_json: String = row.get(6)?;
    let observed_binding_json: Option<String> = row.get(15)?;
    let selector_paths = serde_json::from_str(&selector_paths_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let observed_binding = observed_binding_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    15,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    let state_raw: String = row.get(10)?;
    let state = OwnerOutboxState::parse(&state_raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            10,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other("invalid owner outbox state")),
        )
    })?;
    Ok(ParentRow {
        outbox_id: row.get(0)?,
        binding: LiveObjectBinding {
            workspace_id: row.get(1)?,
            main_version_id: row.get(2)?,
            object_id: row.get(3)?,
            lineage_claim_id: row.get(4)?,
            current_path: row.get(5)?,
            selector_paths,
            restore_fence_generation: row.get(7)?,
        },
        base_update_digest: row.get(8)?,
        base_blob_digest: row.get(9)?,
        state,
        pending_bytes: row.get(11)?,
        oldest_entry_at_ms: row.get(12)?,
        next_sequence: row.get(13)?,
        quarantine_reason: row.get(14)?,
        observed_binding,
    })
}

fn normalize_path(path: &str) -> Result<String, OwnerOutboxError> {
    validate_addressable_plaintext_path(path)
        .map_err(|_| OwnerOutboxError::InvalidInput("binding path is invalid"))
}

fn require_workspace(expected: &str, observed: &str) -> Result<(), OwnerOutboxError> {
    if expected == observed {
        Ok(())
    } else {
        Err(OwnerOutboxError::WorkspaceMismatch)
    }
}

fn validate_identifier(value: &str, reason: &'static str) -> Result<(), OwnerOutboxError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(OwnerOutboxError::InvalidInput(reason));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), OwnerOutboxError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(OwnerOutboxError::InvalidInput(
            "update digest must be lowercase hexadecimal SHA-256",
        ));
    }
    if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(OwnerOutboxError::InvalidInput(
            "update digest must be lowercase hexadecimal SHA-256",
        ));
    }
    Ok(())
}

fn binding_json(binding: &LiveObjectBinding) -> Result<String, OwnerOutboxError> {
    serde_json::to_string(binding)
        .map_err(|_| OwnerOutboxError::InvalidInput("binding is not serializable"))
}

fn outbox_id(binding: &LiveObjectBinding, base_digest: &str, binding_json: &str) -> String {
    let identity = format!(
        "{}\0{}\0{}",
        binding.workspace_id, binding_json, base_digest
    );
    format!("owner-outbox-{}", hex_sha256(identity.as_bytes()))
}

fn delivery_id(outbox_id: &str, sequence: i64, update_digest: &str) -> String {
    let identity = format!("{outbox_id}\0{sequence}\0{update_digest}");
    format!("owner-delivery-{}", hex_sha256(identity.as_bytes()))
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, OwnerOutboxError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(OwnerOutboxError::Corrupt),
    }
}

fn delete_binary_blob_if_unreferenced(
    conn: &Connection,
    digest: &str,
) -> Result<(), OwnerOutboxError> {
    match conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [digest]) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(error, message))
            if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                || (error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
                    && message.as_deref() == Some("FOREIGN KEY constraint failed")) =>
        {
            Ok(())
        }
        Err(error) => Err(write_sql(error)),
    }
}

fn read_sql(error: rusqlite::Error) -> OwnerOutboxError {
    OwnerOutboxError::Storage(StorageError::corrupt_public(error))
}

fn write_sql(error: rusqlite::Error) -> OwnerOutboxError {
    OwnerOutboxError::Storage(StorageError::persist_public(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    fn store(tag: &str) -> (ScratchDir, EngineStore) {
        let dir = ScratchDir::new_named(tag).expect("scratch");
        let store = EngineStore::open(&dir.join("engine.db"), 1).expect("store");
        (dir, store)
    }

    fn binding() -> LiveObjectBinding {
        LiveObjectBinding {
            workspace_id: "workspace-1".to_owned(),
            main_version_id: "main-1".to_owned(),
            object_id: "object-1".to_owned(),
            lineage_claim_id: "lineage-1".to_owned(),
            current_path: "notes/owner.md".to_owned(),
            selector_paths: vec!["notes/owner.md".to_owned()],
            restore_fence_generation: 7,
        }
    }

    fn input(key: &str, update: &[u8], at: i64) -> OwnerOutboxAppendInput {
        OwnerOutboxAppendInput {
            binding: binding(),
            base_update: b"base update".to_vec(),
            append_key: key.to_owned(),
            update: update.to_vec(),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 10_000,
                max_pending_age_ms: 10_000,
            },
            created_at_ms: at,
        }
    }

    fn receipt(entry: &OwnerOutboxEntry) -> OwnerDeliveryReceipt {
        OwnerDeliveryReceipt {
            delivery_id: entry.delivery_id.clone(),
            update_digest: entry.update_digest.clone(),
            journal_cursor: entry.sequence,
            accepting_host_epoch: "host-epoch-1".to_owned(),
        }
    }

    #[test]
    fn immutable_parent_binding_and_base_update_are_refused() {
        let (_dir, mut store) = store("owner-outbox-parent");
        append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("append");
        let mut changed_binding = input("key-2", b"two", 11);
        changed_binding.binding.current_path = "other.md".to_owned();
        assert!(matches!(
            append(&mut store, "workspace-1", changed_binding),
            Err(OwnerOutboxError::ParentMismatch)
        ));
        let mut changed_base = input("key-3", b"three", 12);
        changed_base.base_update = b"different base".to_vec();
        assert!(matches!(
            append(&mut store, "workspace-1", changed_base),
            Err(OwnerOutboxError::ParentMismatch)
        ));
    }

    #[test]
    fn append_key_payload_mismatch_is_refused() {
        let (_dir, mut store) = store("owner-outbox-key");
        append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("append");
        assert!(matches!(
            append(&mut store, "workspace-1", input("key-1", b"changed", 11)),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
    }

    #[test]
    fn sequence_numbers_increase() {
        let (_dir, mut store) = store("owner-outbox-sequence");
        let first = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("first");
        let second = append(&mut store, "workspace-1", input("key-2", b"two", 11)).expect("second");
        assert_eq!((first.sequence, second.sequence), (1, 2));
    }

    #[test]
    fn delivery_id_is_stable_across_reopen() {
        let (dir, mut store) = store("owner-outbox-reopen");
        let first = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("first");
        drop(store);
        let mut reopened = EngineStore::open(&dir.join("engine.db"), 20).expect("reopen");
        let replay =
            append(&mut reopened, "workspace-1", input("key-1", b"one", 10)).expect("replay");
        assert_eq!(replay, first);
    }

    #[test]
    fn append_key_replay_preserves_the_original_result_while_later_entries_are_pending() {
        let (_dir, mut store) = store("owner-outbox-pending-replay");
        let first = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("first");
        append(&mut store, "workspace-1", input("key-2", b"two", 11)).expect("second");

        let replay = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("replay");
        assert_eq!(replay, first);
    }

    #[test]
    fn acknowledged_append_key_replay_survives_reopen_without_reentering_pending() {
        let (dir, mut store) = store("owner-outbox-acknowledged-replay");
        let first = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("first");
        let update_digest = first.update_digest.clone();
        let pending = read_pending(&store, "workspace-1", &first.outbox_id).expect("pending");
        acknowledge(
            &mut store,
            "workspace-1",
            &first.outbox_id,
            &[receipt(&pending.entries[0])],
        )
        .expect("acknowledge");
        drop(store);

        let mut reopened = EngineStore::open(&dir.join("engine.db"), 20).expect("reopen");
        let replay =
            append(&mut reopened, "workspace-1", input("key-1", b"one", 10)).expect("replay");
        assert_eq!(replay, first);
        assert!(
            read_pending(&reopened, "workspace-1", &first.outbox_id)
                .expect("pending after replay")
                .entries
                .is_empty(),
            "an acknowledged append-key replay must not recreate delivery work"
        );

        let mut changed_binding = input("key-1", b"one", 10);
        changed_binding.binding.current_path = "notes/renamed.md".to_owned();
        assert!(matches!(
            append(&mut reopened, "workspace-1", changed_binding),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
        let mut changed_base = input("key-1", b"one", 10);
        changed_base.base_update = b"different base".to_vec();
        assert!(matches!(
            append(&mut reopened, "workspace-1", changed_base),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
        assert!(matches!(
            append(&mut reopened, "workspace-1", input("key-1", b"changed", 10)),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
        assert_eq!(
            reopened
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT pending,update_blob_digest FROM owner_ydoc_outbox_entries \
                         WHERE append_key='key-1'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                })
                .expect("read acknowledged tombstone"),
            (0, None),
            "the acknowledged tombstone must release its full update blob reference"
        );
        assert!(
            reopened
                .get_binary_blob(&update_digest)
                .expect("read unique update blob")
                .is_none(),
            "an acknowledged update with no other owner must release its full blob"
        );
    }

    #[test]
    fn acknowledgement_keeps_a_shared_update_blob_owned_by_the_base() {
        let (_dir, mut store) = store("owner-outbox-shared-update-blob");
        let shared_bytes = b"shared base and update";
        let mut shared_input = input("key-1", shared_bytes, 10);
        shared_input.base_update = shared_bytes.to_vec();
        let first = append(&mut store, "workspace-1", shared_input).expect("append");
        let pending = read_pending(&store, "workspace-1", &first.outbox_id).expect("pending");

        let result = acknowledge(
            &mut store,
            "workspace-1",
            &first.outbox_id,
            &[receipt(&pending.entries[0])],
        )
        .expect("a shared blob reference must not refuse acknowledgement");

        assert_eq!(result.acknowledged, 1);
        assert_eq!(result.pending_bytes, 0);
        assert_eq!(
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT pending,update_blob_digest FROM owner_ydoc_outbox_entries \
                         WHERE append_key='key-1'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                })
                .expect("read committed tombstone"),
            (0, None),
            "the tombstone must commit after the expected foreign-key refusal"
        );
        assert_eq!(
            store
                .get_binary_blob(&first.update_digest)
                .expect("read shared blob"),
            Some(shared_bytes.to_vec()),
            "the parent base reference must retain the shared content-addressed blob"
        );
    }

    #[test]
    fn pending_entries_require_a_full_update_blob_reference() {
        let (_dir, mut store) = store("owner-outbox-pending-blob-reference");
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("append")
            .outbox_id;

        let illegal = store.write_with(&NoFaults, |tx| -> Result<usize, OwnerOutboxError> {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET update_blob_digest=NULL \
                 WHERE append_key='key-1' AND pending=1",
                [],
            )
            .map_err(write_sql)
        });

        assert!(
            illegal.is_err(),
            "the schema must reject a pending entry without its full update blob"
        );
        assert!(
            read_pending(&store, "workspace-1", &outbox)
                .expect("pending after refused mutation")
                .entries[0]
                .update
                .eq(b"one"),
            "the refused mutation must leave the pending blob intact"
        );
    }

    #[test]
    fn acknowledgement_matches_only_a_contiguous_prefix() {
        let (_dir, mut store) = store("owner-outbox-prefix");
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("first")
            .outbox_id;
        append(&mut store, "workspace-1", input("key-2", b"two", 11)).expect("second");
        append(&mut store, "workspace-1", input("key-3", b"three", 12)).expect("third");
        let pending = read_pending(&store, "workspace-1", &outbox).expect("pending");
        let reversed = [receipt(&pending.entries[1]), receipt(&pending.entries[0])];
        assert!(matches!(
            acknowledge(&mut store, "workspace-1", &outbox, &reversed),
            Err(OwnerOutboxError::ReceiptMismatch)
        ));
        let prefix = [receipt(&pending.entries[0]), receipt(&pending.entries[1])];
        let result = acknowledge(&mut store, "workspace-1", &outbox, &prefix).expect("ack");
        assert_eq!(result.acknowledged, 2);
        assert_eq!(
            read_pending(&store, "workspace-1", &outbox)
                .expect("remaining")
                .entries[0]
                .sequence,
            3
        );
    }

    #[test]
    fn delivery_digest_mismatch_is_refused() {
        let (_dir, mut store) = store("owner-outbox-digest");
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("append")
            .outbox_id;
        let pending = read_pending(&store, "workspace-1", &outbox).expect("pending");
        let mut mismatched = receipt(&pending.entries[0]);
        mismatched.update_digest = "0".repeat(64);
        assert!(matches!(
            acknowledge(&mut store, "workspace-1", &outbox, &[mismatched]),
            Err(OwnerOutboxError::ReceiptMismatch)
        ));
        assert_eq!(
            read_pending(&store, "workspace-1", &outbox)
                .expect("still pending")
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn quarantine_preserves_base_and_pending_updates() {
        let (_dir, mut store) = store("owner-outbox-quarantine");
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("append")
            .outbox_id;
        quarantine(
            &mut store,
            "workspace-1",
            OwnerOutboxQuarantineInput {
                outbox_id: outbox.clone(),
                reason: "restore-fence-mismatch".to_owned(),
                observed_binding: Some(binding()),
            },
        )
        .expect("quarantine");
        let pending = read_pending(&store, "workspace-1", &outbox).expect("pending");
        assert_eq!(pending.state, OwnerOutboxState::Quarantined);
        assert_eq!(pending.base_update, b"base update");
        assert_eq!(pending.entries[0].update, b"one");
    }

    #[test]
    fn limit_triggering_append_is_preserved_and_seals_queue() {
        let (_dir, mut store) = store("owner-outbox-limit");
        let mut limited = input("key-1", b"one", 10);
        limited.limits.max_pending_bytes = 3;
        let result = append(&mut store, "workspace-1", limited).expect("append");
        assert_eq!(result.state, OwnerOutboxState::Sealed);
        let pending = read_pending(&store, "workspace-1", &result.outbox_id).expect("pending");
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].update, b"one");
    }

    #[test]
    fn workspace_handle_and_binding_mismatches_are_refused() {
        let (_dir, mut store) = store("owner-outbox-workspace");
        assert!(matches!(
            append(&mut store, "workspace-2", input("key-1", b"one", 10)),
            Err(OwnerOutboxError::WorkspaceMismatch)
        ));
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("append")
            .outbox_id;
        assert!(matches!(
            read_pending(&store, "workspace-2", &outbox),
            Err(OwnerOutboxError::WorkspaceMismatch)
        ));
    }
}
