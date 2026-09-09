//! Durable owner-authored Y.Doc delivery queue.
//!
//! This queue is intentionally separate from the ordinary Y.Doc update log,
//! replication, settlement, and materialization. It retains an immutable live
//! object binding plus a base update until a configured service host returns a
//! durable receipt for each ordered update.

use crate::live_object_binding::LiveObjectBinding;
use dohc_engine_storage::{
    get_binary_blob, hex_sha256, put_binary_blob_with_sha, EngineStore, NoFaults, StorageError,
    TxnOutcome, MAX_IDENTIFIER_BYTES,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

mod native_source;
pub(crate) use native_source::retain_native_source;
pub use native_source::{OwnerOutboxNativeOrigin, OwnerOutboxNativeSource};

#[derive(Debug, thiserror::Error)]
pub enum OwnerOutboxError {
    #[error("owner Y.Doc outbox input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("owner Y.Doc outbox workspace does not match the engine handle")]
    WorkspaceMismatch,
    #[error("owner Y.Doc outbox main version does not match durable workspace state")]
    MainVersionMismatch,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxLimits {
    pub max_pending_bytes: i64,
    pub max_pending_age_ms: i64,
}

impl OwnerOutboxLimits {
    pub fn validate(&self) -> Result<(), OwnerOutboxError> {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerOutboxReadPart {
    Header,
    Base,
    EntryHeader,
    Update,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxReadCursor {
    pub snapshot: String,
    pub part: OwnerOutboxReadPart,
    pub sequence: i64,
    pub offset: i64,
}

#[derive(Debug)]
pub struct OwnerOutboxReadPage {
    pub cursor: OwnerOutboxReadCursor,
    pub total_bytes: i64,
    pub digest: String,
    pub bytes: Vec<u8>,
    pub next_cursor: Option<OwnerOutboxReadCursor>,
}

#[derive(Debug)]
pub enum OwnerOutboxPageResult {
    Page(OwnerOutboxReadPage),
    ReadChanged,
}

#[derive(Debug, Clone)]
pub struct OwnerDeliveryReceipt {
    pub delivery_id: String,
    pub update_digest: String,
    pub journal_cursor: i64,
    pub accepting_host_epoch: i64,
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
    let outcome = store.write_with(&NoFaults, |tx| append_in_tx(tx, workspace_id, input))?;
    committed(outcome)
}

pub fn append_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: OwnerOutboxAppendInput,
) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
    require_workspace(workspace_id, &input.binding.workspace_id)?;
    let key = crate::DocKey::new(
        &input.binding.workspace_id,
        &input.binding.main_version_id,
        &input.binding.object_id,
    )
    .map_err(|_| OwnerOutboxError::InvalidInput("invalid document identity"))?;
    let current = crate::live_update_application::restore_fence::resumed_binding(tx, &key)
        .map_err(map_restore_error)?;
    if current
        .as_ref()
        .is_some_and(|binding| binding != &input.binding)
    {
        return Err(OwnerOutboxError::Frozen);
    };
    append_with_retained_base(tx, workspace_id, input, None)
}

fn append_with_retained_base(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: OwnerOutboxAppendInput,
    retained_base: Option<(String, i64)>,
) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
    let binding = input
        .binding
        .normalized()
        .map_err(OwnerOutboxError::InvalidInput)?;
    require_workspace(workspace_id, &binding.workspace_id)?;
    input.limits.validate()?;
    // The private retained-base path already read these controls in this transaction.
    if retained_base.is_none() {
        let adopted: Option<(String, i64, i64)> = tx.query_row(
        "SELECT binding_json,max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional().map_err(read_sql)?;
        if let Some((saved_binding, bytes, age)) = adopted {
            let saved: LiveObjectBinding =
                serde_json::from_str(&saved_binding).map_err(|_| OwnerOutboxError::Corrupt)?;
            let key = crate::DocKey::new(
                &binding.workspace_id,
                &binding.main_version_id,
                &binding.object_id,
            )
            .map_err(|_| OwnerOutboxError::Corrupt)?;
            let authorized =
                crate::live_update_application::restore_fence::resumed_binding(tx, &key)
                    .map_err(map_restore_error)?
                    .unwrap_or(saved);
            if authorized != binding {
                return Err(OwnerOutboxError::ParentMismatch);
            }
            if input.limits.max_pending_bytes != bytes || input.limits.max_pending_age_ms != age {
                return Err(OwnerOutboxError::InvalidInput(
                    "append limits differ from persisted owner adoption",
                ));
            }
        }
    }
    validate_identifier(
        &input.append_key,
        "append key must be non-empty and bounded",
    )?;
    if (input.base_update.is_empty() && retained_base.is_none()) || input.update.is_empty() {
        return Err(OwnerOutboxError::InvalidInput(
            "base and update bytes must not be empty",
        ));
    }
    if input.created_at_ms < 0 {
        return Err(OwnerOutboxError::InvalidInput(
            "creation time must be non-negative",
        ));
    }

    let (base_update_digest, base_byte_length) = retained_base.clone().unwrap_or_else(|| {
        (
            hex_sha256(&input.base_update),
            input.base_update.len() as i64,
        )
    });
    let update_digest = hex_sha256(&input.update);
    let binding_json = binding_json(&binding)?;
    let outbox_id = outbox_id(&binding, &base_update_digest, &binding_json);

    let durable_main_version_id = tx
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [&binding.workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(read_sql)?;
    if durable_main_version_id.as_deref() != Some(binding.main_version_id.as_str()) {
        return Err(OwnerOutboxError::MainVersionMismatch);
    }

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
            if retained_base.is_none() {
                put_binary_blob_with_sha(tx, &input.base_update, &base_update_digest)?;
            }
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
                        base_byte_length,
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
    let pending_bytes =
        parent
            .pending_bytes
            .checked_add(byte_length)
            .ok_or(OwnerOutboxError::InvalidInput(
                "pending byte count overflow",
            ))?;
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
}

/// Called only by the ordinary local append transaction. Remote applications
/// use their own receipt ledger and never enter this path.
pub fn append_adopted_local_update_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &crate::DocKey,
    path: &str,
    sequence: i64,
    update: &[u8],
    now_ms: i64,
) -> Result<(), crate::CollabError> {
    use crate::CollabError;
    let map = |error: OwnerOutboxError| match error {
        OwnerOutboxError::Frozen => CollabError::OwnerOutboxFrozen,
        OwnerOutboxError::Storage(error) => CollabError::Storage(error),
        error => CollabError::Corrupt {
            reason: format!("adopted owner outbox: {error}"),
        },
    };
    let marker = crate::durable::read_marker_in(tx, key)?.ok_or(CollabError::NoMarker)?;
    let Some(lineage) = marker.lineage_claim_id else {
        return Ok(());
    };
    let saved: Option<(String, i64, i64, String)> = tx
        .query_row(
            "SELECT binding_json,max_pending_bytes,max_pending_age_ms,adoption_id FROM live_owner_adoptions
         WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![key.workspace_id, key.version_id, key.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(read_sql)
        .map_err(map)?;
    let Some((binding_json, max_pending_bytes, max_pending_age_ms, adoption_id)) = saved else {
        return Ok(());
    };
    let original: LiveObjectBinding =
        serde_json::from_str(&binding_json).map_err(|_| map(OwnerOutboxError::Corrupt))?;
    let binding = crate::live_update_application::restore_fence::resumed_binding(tx, key)?
        .unwrap_or(original);
    if binding.workspace_id != key.workspace_id
        || binding.main_version_id != key.version_id
        || binding.object_id != key.object_id
        || binding.lineage_claim_id != lineage
        || binding.current_path != path
        || marker.path.as_deref() != Some(path)
    {
        return Err(map(OwnerOutboxError::ParentMismatch));
    }
    // Adoption authenticated these immutable bytes. Each keystroke needs only
    // their retained metadata; loading and hashing the full base scales with
    // document size instead of edit size.
    let base_byte_length: i64 = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes)",
            [&lineage],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)
        .map_err(map)?
        .filter(|length| *length > 0)
        .ok_or_else(|| map(OwnerOutboxError::Corrupt))?;
    let source = native_source::read_native_update_source(tx, &binding, &adoption_id, sequence)
        .map_err(map)?;
    if source.update_digest != hex_sha256(update) {
        return Err(map(OwnerOutboxError::Corrupt));
    }
    let append_key = source.append_key().map_err(map)?;
    let result = append_with_retained_base(
        tx,
        &key.workspace_id,
        OwnerOutboxAppendInput {
            binding,
            base_update: Vec::new(),
            append_key,
            update: update.to_vec(),
            limits: OwnerOutboxLimits {
                max_pending_bytes,
                max_pending_age_ms,
            },
            created_at_ms: now_ms,
        },
        Some((lineage, base_byte_length)),
    )
    .map_err(map)?;
    retain_native_source(tx, &result, &source).map_err(map)?;
    Ok(())
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

/// A page is provisional until the client has verified every complete part.
/// Each transaction binds its metadata and bounded blob slice to one snapshot;
/// no transaction or hydrated queue is retained between requests.
pub fn read_pending_page(
    store: &EngineStore,
    workspace_id: &str,
    outbox_id: &str,
    cursor: Option<OwnerOutboxReadCursor>,
    max_bytes: usize,
) -> Result<OwnerOutboxPageResult, OwnerOutboxError> {
    validate_identifier(outbox_id, "outbox id must be non-empty and bounded")?;
    if max_bytes == 0 || max_bytes > dohc_engine_storage::MAX_BLOB_BYTES {
        return Err(OwnerOutboxError::InvalidInput(
            "invalid read page byte budget",
        ));
    }
    if let Some(cursor) = &cursor {
        if cursor.snapshot.len() != 64
            || !cursor
                .snapshot
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || cursor.offset < 0
            || cursor.sequence < 0
        {
            return Err(OwnerOutboxError::InvalidInput("invalid read cursor"));
        }
    }
    store.read_with(|conn| {
        let tx = conn.unchecked_transaction().map_err(read_sql)?;
        let parent = read_parent(&tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        if parent.base_blob_digest != parent.base_update_digest {
            return Err(OwnerOutboxError::Corrupt);
        }
        let base_length: i64 = tx.query_row(
            "SELECT base_byte_length FROM owner_ydoc_outboxes WHERE outbox_id=?1",
            [outbox_id], |row| row.get(0),
        ).map_err(read_sql)?;
        let mut header = serde_json::json!({
            "outboxId": parent.outbox_id,
            "binding": parent.binding,
            "baseUpdateDigest": parent.base_update_digest,
            "baseByteLength": base_length,
            "state": parent.state.as_str(),
            "pendingBytes": parent.pending_bytes,
            "oldestEntryAtMs": parent.oldest_entry_at_ms,
            "nextSequence": parent.next_sequence,
            "quarantineReason": parent.quarantine_reason,
            "observedBinding": parent.observed_binding,
        });
        let snapshot = hex_sha256(&page_json(&header)?);
        if cursor.as_ref().is_some_and(|cursor| cursor.snapshot != snapshot) {
            return Ok(OwnerOutboxPageResult::ReadChanged);
        }
        let cursor = cursor.unwrap_or(OwnerOutboxReadCursor {
            snapshot,
            part: OwnerOutboxReadPart::Header,
            sequence: 0,
            offset: 0,
        });
        use OwnerOutboxReadPart::{Base, EntryHeader, Header, Update};
        if matches!(cursor.part, Header | Base) != (cursor.sequence == 0)
            || cursor.sequence >= parent.next_sequence
        {
            return Err(OwnerOutboxError::InvalidInput("invalid read part sequence"));
        }
        let next_entry = |after: i64| -> Result<Option<OwnerOutboxReadCursor>, OwnerOutboxError> {
            tx.query_row(
                "SELECT sequence FROM owner_ydoc_outbox_entries \
                 WHERE outbox_id=?1 AND pending=1 AND sequence>?2 AND sequence<?3 \
                 ORDER BY sequence LIMIT 1",
                params![outbox_id, after, parent.next_sequence], |row| row.get(0),
            ).optional().map_err(read_sql).map(|sequence| sequence.map(|sequence| {
                OwnerOutboxReadCursor { snapshot: cursor.snapshot.clone(), part: EntryHeader, sequence, offset: 0 }
            }))
        };
        let following_part = |part| Some(OwnerOutboxReadCursor {
            snapshot: cursor.snapshot.clone(), part, sequence: cursor.sequence, offset: 0,
        });
        let (total_bytes, digest, bytes, following) = match cursor.part {
            Header => {
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1",
                    [outbox_id], |row| row.get(0),
                ).map_err(read_sql)?;
                header["pendingEntryCount"] = count.into();
                header["firstEntryCursor"] = serde_json::to_value(next_entry(0)?)
                    .map_err(|_| OwnerOutboxError::Corrupt)?;
                let bytes = page_json(&header)?;
                let (total, digest, bytes) = slice_header(bytes, cursor.offset, max_bytes)?;
                (total, digest, bytes, following_part(Base))
            }
            Base => {
                let bytes = slice_blob(&tx, &parent.base_blob_digest, base_length, cursor.offset, max_bytes)?;
                (base_length, parent.base_update_digest, bytes, next_entry(0)?)
            }
            EntryHeader | Update => {
                let entry = tx.query_row(
                    "SELECT append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms \
                     FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2 AND pending=1",
                    params![outbox_id, cursor.sequence], |row| Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
                    )),
                ).optional().map_err(read_sql)?.ok_or(OwnerOutboxError::InvalidInput("invalid read entry"))?;
                let (append_key, delivery_id, digest, blob_digest, byte_length, created_at_ms) = entry;
                if digest != blob_digest || byte_length <= 0 {
                    return Err(OwnerOutboxError::Corrupt);
                }
                if cursor.part == EntryHeader {
                    let bytes = page_json(&serde_json::json!({
                        "sequence": cursor.sequence, "appendKey": append_key,
                        "deliveryId": delivery_id, "updateDigest": digest,
                        "byteLength": byte_length, "createdAtMs": created_at_ms,
                    }))?;
                    let (total, digest, bytes) = slice_header(bytes, cursor.offset, max_bytes)?;
                    (total, digest, bytes, following_part(Update))
                } else {
                    let bytes = slice_blob(&tx, &blob_digest, byte_length, cursor.offset, max_bytes)?;
                    (byte_length, digest, bytes, next_entry(cursor.sequence)?)
                }
            }
        };
        let end = cursor.offset + bytes.len() as i64;
        let next_cursor = if end < total_bytes {
            Some(OwnerOutboxReadCursor { offset: end, ..cursor.clone() })
        } else {
            following
        };
        tx.commit().map_err(read_sql)?;
        Ok(OwnerOutboxPageResult::Page(OwnerOutboxReadPage {
            cursor, total_bytes, digest, bytes, next_cursor,
        }))
    })
}

fn page_json(value: &serde_json::Value) -> Result<Vec<u8>, OwnerOutboxError> {
    serde_json::to_vec(value).map_err(|_| OwnerOutboxError::Corrupt)
}

fn slice_header(
    bytes: Vec<u8>,
    offset: i64,
    max_bytes: usize,
) -> Result<(i64, String, Vec<u8>), OwnerOutboxError> {
    let start = usize::try_from(offset)
        .map_err(|_| OwnerOutboxError::InvalidInput("invalid read offset"))?;
    if start >= bytes.len() {
        return Err(OwnerOutboxError::InvalidInput("invalid read offset"));
    }
    let end = start.saturating_add(max_bytes).min(bytes.len());
    Ok((
        bytes.len() as i64,
        hex_sha256(&bytes),
        bytes[start..end].to_vec(),
    ))
}

fn slice_blob(
    conn: &Connection,
    digest: &str,
    total: i64,
    offset: i64,
    max_bytes: usize,
) -> Result<Vec<u8>, OwnerOutboxError> {
    if total <= 0 || total as u64 > dohc_engine_storage::MAX_BLOB_BYTES as u64 {
        return Err(OwnerOutboxError::Corrupt);
    }
    if offset < 0 || offset >= total {
        return Err(OwnerOutboxError::InvalidInput("invalid read offset"));
    }
    let length = (total - offset).min(max_bytes as i64);
    let (recorded, actual, bytes): (i64, i64, Vec<u8>) = conn.query_row(
        "SELECT byte_length,length(bytes),substr(bytes,?2,?3) FROM binary_blobs WHERE sha256=?1",
        params![digest, offset + 1, length], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(read_sql)?.ok_or(OwnerOutboxError::Corrupt)?;
    if recorded != total || actual != total || bytes.len() as i64 != length {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(bytes)
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
        if !(1..=9_007_199_254_740_991).contains(&receipt.accepting_host_epoch) {
            return Err(OwnerOutboxError::InvalidInput(
                "accepting host epoch must be a positive safe integer",
            ));
        }
        if !(1..=9_007_199_254_740_991).contains(&receipt.journal_cursor) {
            return Err(OwnerOutboxError::InvalidInput(
                "journal cursor must be a positive safe integer",
            ));
        }
    }

    let outcome = store.write_with(&NoFaults, |tx| {
        let parent = read_parent(tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        if parent.state == OwnerOutboxState::Quarantined {
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
            "UPDATE owner_ydoc_outboxes SET pending_bytes=?2,oldest_entry_at_ms=?3, \
             state=CASE WHEN state='sealed' AND ?2=0 THEN 'active' ELSE state END WHERE outbox_id=?1",
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
        .map(|binding| binding.normalized().map_err(OwnerOutboxError::InvalidInput))
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
         AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            binding.restore_fence_generation,
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
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
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

pub(crate) fn outbox_id(
    binding: &LiveObjectBinding,
    base_digest: &str,
    binding_json: &str,
) -> String {
    let identity = format!(
        "{}\0{}\0{}",
        binding.workspace_id, binding_json, base_digest
    );
    format!("owner-outbox-{}", hex_sha256(identity.as_bytes()))
}

pub(crate) fn delivery_id(outbox_id: &str, sequence: i64, update_digest: &str) -> String {
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

fn map_restore_error(error: crate::CollabError) -> OwnerOutboxError {
    match error {
        crate::CollabError::RestoreFenced => OwnerOutboxError::Frozen,
        crate::CollabError::Storage(error) => OwnerOutboxError::Storage(error),
        _ => OwnerOutboxError::Corrupt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    fn store(tag: &str) -> (ScratchDir, EngineStore) {
        let dir = ScratchDir::new_named(tag).expect("scratch");
        let mut store = EngineStore::open(&dir.join("engine.db"), 1).expect("store");
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace-1", "main-1", 1, &NoFaults)
            .expect("main version");
        (dir, store)
    }

    fn durable_write_counts(store: &EngineStore) -> (i64, i64, i64) {
        store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM owner_ydoc_outboxes", [], |row| {
                        row.get(0)
                    })?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM owner_ydoc_outbox_entries",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| row.get(0))?,
                ))
            })
            .expect("durable write counts")
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
            accepting_host_epoch: 1,
        }
    }

    fn page(
        store: &EngineStore,
        id: &str,
        cursor: Option<OwnerOutboxReadCursor>,
        budget: usize,
    ) -> OwnerOutboxReadPage {
        match read_pending_page(store, "workspace-1", id, cursor, budget).expect("read page") {
            OwnerOutboxPageResult::Page(page) => page,
            OwnerOutboxPageResult::ReadChanged => panic!("unchanged snapshot"),
        }
    }

    #[test]
    fn paged_read_slices_individual_blobs_and_preserves_complete_ordered_snapshot() {
        let (_dir, mut store) = store("owner-paged-read");
        let mut first = input("first", &vec![23; 263], 1);
        first.base_update = vec![17; 257];
        let appended = append(&mut store, "workspace-1", first.clone()).expect("append");
        first.append_key = "second".to_owned();
        first.update = vec![31; 269];
        append(&mut store, "workspace-1", first).expect("second append");
        let expected =
            read_pending(&store, "workspace-1", &appended.outbox_id).expect("whole reference");
        let mut cursor = None;
        let mut parts: Vec<(OwnerOutboxReadPart, i64, Vec<u8>)> = Vec::new();
        let mut snapshot = None;
        loop {
            let page = page(&store, &appended.outbox_id, cursor, 17);
            if let Some(snapshot) = &snapshot {
                assert_eq!(snapshot, &page.cursor.snapshot);
            }
            snapshot = Some(page.cursor.snapshot.clone());
            assert!(!page.bytes.is_empty() && page.bytes.len() <= 17);
            if page.cursor.offset == 0 {
                parts.push((page.cursor.part, page.cursor.sequence, Vec::new()));
            }
            let (part, sequence, bytes) = parts.last_mut().expect("part");
            assert_eq!((*part, *sequence), (page.cursor.part, page.cursor.sequence));
            assert_eq!(bytes.len() as i64, page.cursor.offset);
            bytes.extend(page.bytes);
            if bytes.len() as i64 == page.total_bytes {
                assert_eq!(hex_sha256(bytes), page.digest);
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(parts.len(), 6);
        assert_eq!(parts[1].2, expected.base_update);
        assert_eq!(parts[3].2, expected.entries[0].update);
        assert_eq!(parts[5].2, expected.entries[1].update);
        let header: serde_json::Value = serde_json::from_slice(&parts[0].2).expect("header");
        assert_eq!(header["pendingBytes"], expected.pending_bytes);
        assert_eq!(header["pendingEntryCount"], 2);
    }

    #[test]
    fn header_entry_cursor_skips_base_and_tracks_acknowledged_prefixes() {
        let (_dir, mut store) = store("owner-delivery-head");
        let mut entry = input("first", b"a", 1);
        entry.base_update = vec![17; 1_048_576];
        let appended = append(&mut store, "workspace-1", entry.clone()).expect("first");
        entry.append_key = "second".to_owned();
        append(&mut store, "workspace-1", entry.clone()).expect("second");
        entry.append_key = "third".to_owned();
        append(&mut store, "workspace-1", entry).expect("third");
        let pending = read_pending(&store, "workspace-1", &appended.outbox_id).expect("reference");
        let mut stale_cursor = None;
        for (index, sequence) in [(0, 1), (2, 3)] {
            let header = page(&store, &appended.outbox_id, None, 4096);
            assert_eq!(hex_sha256(&header.bytes), header.digest);
            let raw: serde_json::Value = serde_json::from_slice(&header.bytes).expect("header");
            assert_eq!(raw["baseByteLength"], 1_048_576);
            assert_eq!(
                header.next_cursor.as_ref().expect("base").part,
                OwnerOutboxReadPart::Base
            );
            let first: OwnerOutboxReadCursor =
                serde_json::from_value(raw["firstEntryCursor"].clone()).expect("first entry");
            assert_eq!(first.snapshot, header.cursor.snapshot);
            assert_eq!(
                (first.part, first.sequence, first.offset),
                (OwnerOutboxReadPart::EntryHeader, sequence, 0)
            );
            if let Some(stale) = stale_cursor.take() {
                assert!(matches!(
                    read_pending_page(
                        &store,
                        "workspace-1",
                        &appended.outbox_id,
                        Some(stale),
                        4096
                    ),
                    Ok(OwnerOutboxPageResult::ReadChanged)
                ));
            }
            let entry_header = page(&store, &appended.outbox_id, Some(first.clone()), 4096);
            let update = page(&store, &appended.outbox_id, entry_header.next_cursor, 4096);
            assert_eq!(update.cursor.part, OwnerOutboxReadPart::Update);
            assert_eq!(update.bytes, b"a");
            assert_eq!(hex_sha256(&update.bytes), update.digest);
            assert!(header.bytes.len() + entry_header.bytes.len() + update.bytes.len() < 4096);
            stale_cursor = Some(first);
            acknowledge(
                &mut store,
                "workspace-1",
                &appended.outbox_id,
                &pending.entries[index..(index + 2).min(pending.entries.len())]
                    .iter()
                    .map(receipt)
                    .collect::<Vec<_>>(),
            )
            .expect("ack head");
        }
        let header = page(&store, &appended.outbox_id, None, 4096);
        let raw: serde_json::Value = serde_json::from_slice(&header.bytes).expect("empty header");
        assert_eq!(raw["pendingEntryCount"], 0);
        assert!(raw["firstEntryCursor"].is_null());
    }

    #[test]
    fn changed_append_acknowledgment_or_quarantine_invalidates_a_partial_read() {
        for mutation in ["append", "acknowledge", "ack-append", "quarantine"] {
            let (_dir, mut store) = store("owner-page-changed");
            let appended = append(
                &mut store,
                "workspace-1",
                input("first", b"first update", 1),
            )
            .expect("append");
            let pending =
                read_pending(&store, "workspace-1", &appended.outbox_id).expect("pending");
            // Leave the read in the middle of a blob, not merely between rows.
            let first = page(&store, &appended.outbox_id, None, 4096);
            let base = page(&store, &appended.outbox_id, first.next_cursor, 1);
            let cursor = base.next_cursor.expect("base has remaining bytes");
            assert_eq!(cursor.part, OwnerOutboxReadPart::Base);
            match mutation {
                "append" => {
                    append(
                        &mut store,
                        "workspace-1",
                        input("second", b"second update", 2),
                    )
                    .expect("append during read");
                }
                "acknowledge" | "ack-append" => {
                    acknowledge(
                        &mut store,
                        "workspace-1",
                        &appended.outbox_id,
                        &[receipt(&pending.entries[0])],
                    )
                    .expect("ack during read");
                    if mutation == "ack-append" {
                        // Restore byte totals and oldest timestamp; only the
                        // monotonic next_sequence distinguishes this snapshot.
                        append(
                            &mut store,
                            "workspace-1",
                            input("replacement", b"first update", 1),
                        )
                        .expect("replace acknowledged entry");
                    }
                }
                _ => {
                    quarantine(
                        &mut store,
                        "workspace-1",
                        OwnerOutboxQuarantineInput {
                            outbox_id: appended.outbox_id.clone(),
                            reason: "binding changed".to_owned(),
                            observed_binding: None,
                        },
                    )
                    .expect("quarantine during read");
                }
            }
            assert!(
                matches!(
                    read_pending_page(&store, "workspace-1", &appended.outbox_id, Some(cursor), 1),
                    Ok(OwnerOutboxPageResult::ReadChanged)
                ),
                "{mutation}"
            );
        }
    }

    #[test]
    fn page_refuses_invalid_offsets_and_inconsistent_blob_lengths() {
        let (_dir, mut store) = store("owner-page-corrupt");
        let appended =
            append(&mut store, "workspace-1", input("first", b"update", 1)).expect("append");
        let first = page(&store, &appended.outbox_id, None, 4096);
        let mut cursor = first.next_cursor.expect("base cursor");
        cursor.offset = i64::MAX;
        assert!(matches!(
            read_pending_page(&store, "workspace-1", &appended.outbox_id, Some(cursor), 1),
            Err(OwnerOutboxError::InvalidInput(_))
        ));
        let cursor = page(&store, &appended.outbox_id, None, 4096).next_cursor;
        store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                    params![b"short".as_slice(), hex_sha256(b"base update")],
                )
            })
            .expect("damage blob");
        assert!(matches!(
            read_pending_page(&store, "workspace-1", &appended.outbox_id, cursor, 1),
            Err(OwnerOutboxError::Corrupt)
        ));
    }

    #[test]
    fn owner_receipt_numeric_bounds_guard_acknowledgement() {
        fn run_case(tag: &str, epoch: &str, cursor: &str, valid: bool) {
            let (_dir, mut store) = store(tag);
            let outbox_id = append(&mut store, "workspace-1", input("key-1", b"one", 10))
                .expect("append")
                .outbox_id;
            let pending = read_pending(&store, "workspace-1", &outbox_id).expect("pending receipt");
            let receipt = OwnerDeliveryReceipt {
                delivery_id: pending.entries[0].delivery_id.clone(),
                update_digest: pending.entries[0].update_digest.clone(),
                journal_cursor: cursor.parse().expect("cursor fixture"),
                accepting_host_epoch: epoch.parse().expect("epoch fixture"),
            };
            let result = acknowledge(&mut store, "workspace-1", &outbox_id, &[receipt]);

            if valid {
                assert_eq!(result.expect("valid receipt").acknowledged, 1, "{tag}");
                assert!(
                    read_pending(&store, "workspace-1", &outbox_id)
                        .expect("acknowledged pending state")
                        .entries
                        .is_empty(),
                    "{tag}"
                );
            } else {
                assert!(
                    matches!(result, Err(OwnerOutboxError::InvalidInput(_))),
                    "{tag}: {result:?}"
                );
                let after =
                    read_pending(&store, "workspace-1", &outbox_id).expect("refused pending state");
                assert_eq!(after.entries, pending.entries, "{tag}");
                assert_eq!(after.pending_bytes, pending.pending_bytes, "{tag}");
            }
        }

        run_case("owner-receipt-min", "1", "1", true);
        run_case(
            "owner-receipt-max",
            "9007199254740991",
            "9007199254740991",
            true,
        );
        for (tag, epoch) in [
            ("owner-receipt-epoch-zero", "0"),
            ("owner-receipt-epoch-negative", "-1"),
            ("owner-receipt-epoch-overflow", "9007199254740992"),
        ] {
            run_case(tag, epoch, "1", false);
        }
        for (tag, cursor) in [
            ("owner-receipt-cursor-zero", "0"),
            ("owner-receipt-cursor-negative", "-1"),
            ("owner-receipt-cursor-overflow", "9007199254740992"),
        ] {
            run_case(tag, "1", cursor, false);
        }

        let field_type = OwnerDeliveryReceipt {
            delivery_id: "delivery-type".to_owned(),
            update_digest: "0".repeat(64),
            journal_cursor: "1".parse().expect("cursor fixture"),
            accepting_host_epoch: "1".parse().expect("epoch fixture"),
        };
        assert_eq!(
            std::any::type_name_of_val(&field_type.accepting_host_epoch),
            "i64"
        );
    }

    #[test]
    fn mismatched_durable_main_version_refuses_without_writes() {
        let (_dir, mut store) = store("owner-outbox-main-version-mismatch");
        let before = durable_write_counts(&store);
        let mut mismatched = input("key-1", b"one", 10);
        mismatched.binding.main_version_id = "other-main".to_owned();

        assert!(matches!(
            append(&mut store, "workspace-1", mismatched),
            Err(OwnerOutboxError::MainVersionMismatch)
        ));
        assert_eq!(durable_write_counts(&store), before);
    }

    #[test]
    fn absent_durable_main_version_refuses_without_writes() {
        let dir = ScratchDir::new_named("owner-outbox-main-version-absent").expect("scratch");
        let mut store = EngineStore::open(&dir.join("engine.db"), 1).expect("store");
        let before = durable_write_counts(&store);

        assert!(matches!(
            append(&mut store, "workspace-1", input("key-1", b"one", 10)),
            Err(OwnerOutboxError::MainVersionMismatch)
        ));
        assert_eq!(durable_write_counts(&store), before);
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
        assert!(matches!(
            acknowledge(
                &mut store,
                "workspace-1",
                &outbox,
                &[receipt(&pending.entries[0])]
            ),
            Err(OwnerOutboxError::Frozen)
        ));
        let pending = read_pending(&store, "workspace-1", &outbox).expect("still quarantined");
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
    fn sealed_receipt_prefix_leaves_limit_triggering_update_and_durable_seal() {
        for age_limit in [false, true] {
            let (dir, mut store) = store("owner-outbox-sealed-receipt");
            let mut first = input("key-1", b"one", 10);
            if age_limit {
                first.limits.max_pending_age_ms = 10;
            } else {
                first.limits.max_pending_bytes = 6;
            }
            let mut second = first.clone();
            second.append_key = "key-2".to_owned();
            second.update = b"two".to_vec();
            second.created_at_ms = if age_limit { 20 } else { 11 };
            let appended = append(&mut store, "workspace-1", first).expect("first append");
            assert_eq!(appended.state, OwnerOutboxState::Active);
            let id = appended.outbox_id;
            let pending = read_pending(&store, "workspace-1", &id).expect("in-flight prefix");
            let in_flight_receipt = receipt(&pending.entries[0]);
            let sealed = append(&mut store, "workspace-1", second.clone()).expect("limit append");
            assert_eq!(sealed.state, OwnerOutboxState::Sealed);

            let acknowledged = acknowledge(&mut store, "workspace-1", &id, &[in_flight_receipt])
                .expect("matching in-flight receipt after sealing");
            assert_eq!(acknowledged.acknowledged, 1);
            assert_eq!(acknowledged.pending_bytes, 3);
            drop(store);
            let mut store = EngineStore::open(&dir.join("engine.db"), 1).expect("reopen");
            let pending = read_pending(&store, "workspace-1", &id).expect("sealed recovery");
            assert_eq!(pending.state, OwnerOutboxState::Sealed);
            assert_eq!(pending.base_update, b"base update");
            assert_eq!(pending.pending_bytes, 3);
            assert_eq!(pending.entries.len(), 1);
            assert_eq!(pending.entries[0].sequence, 2);
            assert_eq!(pending.entries[0].update, b"two");
            assert!(matches!(
                append(&mut store, "workspace-1", input("key-3", b"three", 21)),
                Err(OwnerOutboxError::Frozen)
            ));
            acknowledge(
                &mut store,
                "workspace-1",
                &id,
                &[receipt(&pending.entries[0])],
            )
            .expect("final sealed receipt");
            drop(store);
            let mut store = EngineStore::open(&dir.join("engine.db"), 1).expect("reopen drained");
            let drained = read_pending(&store, "workspace-1", &id).expect("drained");
            assert_eq!(drained.state, OwnerOutboxState::Active);
            assert_eq!(drained.pending_bytes, 0);
            assert_eq!(drained.oldest_entry_at_ms, None);
            assert!(drained.entries.is_empty());
            assert_eq!(drained.base_update, pending.base_update);
            let replay = append(&mut store, "workspace-1", second.clone()).expect("append replay");
            assert_eq!(replay.delivery_id, sealed.delivery_id);
            assert!(read_pending(&store, "workspace-1", &id)
                .expect("after replay")
                .entries
                .is_empty());
            let mut third = input("key-3", b"three", 21);
            third.limits = second.limits.clone();
            let next = append(&mut store, "workspace-1", third).expect("append after sealed drain");
            assert_eq!(next.outbox_id, id);
            assert_eq!(next.sequence, 3);
            assert_eq!(next.state, OwnerOutboxState::Active);
            let mut fourth = input("key-4", b"x", 31);
            fourth.limits = second.limits;
            let resealed = append(&mut store, "workspace-1", fourth).expect("seal again");
            assert_eq!(resealed.state, OwnerOutboxState::Sealed);
        }
    }

    #[test]
    fn sealed_queue_still_rejects_nonprefix_and_changed_digest_receipts() {
        let (_dir, mut store) = store("owner-outbox-sealed-mismatch");
        let id = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("first")
            .outbox_id;
        let mut second = input("key-2", b"two", 11);
        second.limits.max_pending_bytes = 6;
        append(&mut store, "workspace-1", second).expect("seal");
        let pending = read_pending(&store, "workspace-1", &id).expect("pending");
        let mut changed_digest = receipt(&pending.entries[0]);
        changed_digest.update_digest = "0".repeat(64);
        for mismatched in [receipt(&pending.entries[1]), changed_digest] {
            assert!(matches!(
                acknowledge(&mut store, "workspace-1", &id, &[mismatched]),
                Err(OwnerOutboxError::ReceiptMismatch)
            ));
        }
        let pending = read_pending(&store, "workspace-1", &id).expect("unchanged recovery");
        assert_eq!(pending.state, OwnerOutboxState::Sealed);
        assert_eq!(pending.pending_bytes, 6);
        assert_eq!(pending.entries.len(), 2);
        assert_eq!(pending.entries[0].update, b"one");
        assert_eq!(pending.entries[1].update, b"two");
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
