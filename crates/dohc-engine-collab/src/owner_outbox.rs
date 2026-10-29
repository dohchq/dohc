//! Durable owner-authored Y.Doc delivery queue.
//!
//! This queue is intentionally separate from the ordinary Y.Doc update log,
//! replication, settlement, and materialization. It retains an immutable live
//! object binding plus a base update until a configured service host returns a
//! durable receipt for each ordered update.

use crate::live_object_binding::LiveObjectBinding;
use crate::live_update_application::owner_activations::CURRENT_ACTIVATIONS;
use dohc_engine_domain::{AgentDeclaration, AutomationDeclaration};
use dohc_engine_storage::{
    get_binary_blob, hex_sha256, put_binary_blob_with_sha, EngineStore, NoFaults, StorageError,
    TxnOutcome, MAX_IDENTIFIER_BYTES,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub mod accepted;
pub mod draft;
pub mod enrollment;
mod native_source;
pub mod publication;
mod recovery;
pub mod release;
pub(crate) use native_source::retain_native_source;
pub use native_source::{
    OwnerOutboxDraftOrigin, OwnerOutboxDraftSource, OwnerOutboxNativeOrigin,
    OwnerOutboxNativeSource, OwnerOutboxSource,
};
pub use recovery::{list_restore_fenced_in, OwnerOutboxRestoreFenced};

pub fn has_adopted_owner_in(
    conn: &Connection,
    key: &crate::DocKey,
) -> Result<bool, crate::CollabError> {
    conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {CURRENT_ACTIVATIONS} WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)"),
        params![key.workspace_id,key.version_id,key.object_id], |r| r.get(0))
        .map_err(|error| crate::CollabError::Storage(StorageError::corrupt_public(error)))
}

const OWNER_DRAFT_REFUSAL_ACTOR: &str = "owner-draft-refusal";
const OWNER_DRAFT_QUARANTINE_ACTOR: &str = "owner-draft-quarantine";

/// Diff the visible owner fields against their current Collection index.
pub(super) fn index_frontmatter_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    visible: &crate::Ydoc,
    actor: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let before = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
        tx,
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(index_error)?;
    if let Some(before) = before {
        index_frontmatter_from_in_tx(tx, binding, &before, visible, actor, attribution, now_ms)?;
    }
    Ok(())
}

pub(super) fn index_frontmatter_from_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    before: &serde_json::Value,
    visible: &crate::Ydoc,
    actor: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let after = visible.frontmatter_json();
    dohc_engine_domain::index_collection_frontmatter_apply_in_tx(
        tx,
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
        before,
        &after,
        before,
        &after,
        None,
        actor,
        attribution,
        None,
        now_ms,
    )
    .map_err(index_error)?;
    Ok(())
}

fn index_error(error: dohc_engine_domain::DomainError) -> OwnerOutboxError {
    match error {
        dohc_engine_domain::DomainError::Storage(error) => OwnerOutboxError::Storage(error),
        _ => OwnerOutboxError::Corrupt,
    }
}

/// Where a live frame was accepted, as far as its receiver can tell.
#[derive(Debug, Clone, Copy)]
pub enum AcceptedAs<'a> {
    /// The session host knows the delivery the relay accepted.
    Delivery(&'a str),
    /// The owner's ordered feed carries only the journal cursor.
    JournalCursor(i64),
}

/// Whether a live frame with these bytes for this document is this engine's
/// own draft. The host matches the draft's delivery. The owner matches a
/// draft still waiting for its receipt, or one acknowledged at this cursor,
/// so an old draft's bytes served again under a new cursor are not its own.
/// A frame that is this computer's own draft is not a change from another
/// computer.
pub fn is_own_draft_in(
    conn: &Connection,
    key: &crate::DocKey,
    update_digest: &str,
    accepted: AcceptedAs<'_>,
) -> Result<bool, crate::CollabError> {
    let (delivery_id, journal_cursor) = match accepted {
        AcceptedAs::Delivery(delivery_id) => (Some(delivery_id), None),
        AcceptedAs::JournalCursor(cursor) => (None, Some(cursor)),
    };
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e \
         JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id \
         WHERE e.update_digest=?1 \
           AND o.workspace_id=?2 AND o.main_version_id=?3 AND o.object_id=?4 \
           AND CASE WHEN ?5 IS NOT NULL THEN e.delivery_id=?5 \
                    ELSE e.pending=1 \
                      OR json_extract(e.accepted_receipt_json,'$.journalCursor')=?6 END)",
        params![
            update_digest,
            key.workspace_id,
            key.version_id,
            key.object_id,
            delivery_id,
            journal_cursor
        ],
        |r| r.get(0),
    )
    .map_err(|error| crate::CollabError::Storage(StorageError::corrupt_public(error)))
}

/// Bound owners settle through the admitted host cut, including after their
/// pending queue drains. Ordinary settlement carries no accepted audit cut.
pub fn require_ordinary_settlement(
    conn: &Connection,
    key: &crate::DocKey,
) -> Result<(), crate::CollabError> {
    draft::require_ordinary_write(conn, key)?;
    if has_adopted_owner_in(conn, key)? {
        return Err(crate::CollabError::OwnerOutboxFrozen);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum OwnerOutboxError {
    #[error("this computer hosts the document")]
    DesktopHost,
    #[error("the document restore is not complete")]
    RestorePending,
    #[error("the Stop request changed")]
    StopConflict,
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
    #[error("owner Y.Doc outbox is not quarantined")]
    NotQuarantined,
    /// The writer must build the frozen lineage's recovery checkpoint before a read names it.
    #[error("owner Y.Doc outbox recovery checkpoint is out of date")]
    RecoveryCheckpointOutdated,
    /// A refused seed of a generation its document left has no recovery
    /// checkpoint proven to hold that generation's final accepted state.
    #[error("owner Y.Doc outbox recovery checkpoint is unavailable")]
    RecoveryCheckpointUnavailable,
    #[error("owner Y.Doc outbox accepted state waits on a missing dependency")]
    AcceptedStateIncomplete,
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
    pub person_edit: bool,
    pub agent_declaration: Option<AgentDeclaration>,
    pub automation_declaration: Option<AutomationDeclaration>,
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
    /// The head delivery the owner asked to try once more while quarantined.
    pub retry_delivery_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerOutboxReadPart {
    Header,
    Base,
    EntryHeader,
    Update,
    /// The lineage's accepted checkpoint. Only a recovery copy asks for it.
    Checkpoint,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// A terminal refusal delivery received for the head. The deliverer mints the
/// key once per refusal and sends it with every write of that refusal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxRefusal {
    pub delivery_id: String,
    pub key: String,
}

#[derive(Debug, Clone)]
pub struct OwnerOutboxRetryInput {
    pub outbox_id: String,
    /// The binding generation the owner saw quarantined.
    pub binding: LiveObjectBinding,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxRefuseInput {
    pub outbox_id: String,
    pub delivery_id: String,
    pub update_digest: String,
    pub reason: String,
}

/// The longest reason a terminal entry keeps.
pub(crate) const MAX_TERMINAL_REASON_BYTES: usize = 256;

/// A terminal host refusal retires an entry and its causal dependents,
/// preserving their bytes and provenance. Independent pending writes survive.
pub fn refuse_entry_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    input: &OwnerOutboxRefuseInput,
    now_ms: i64,
) -> Result<LiveObjectBinding, OwnerOutboxError> {
    validate_identifier(&input.outbox_id, "invalid outbox id")?;
    validate_identifier(&input.delivery_id, "invalid delivery id")?;
    validate_identifier(&input.reason, "invalid refusal reason")?;
    if input.reason.len() > MAX_TERMINAL_REASON_BYTES {
        return Err(OwnerOutboxError::InvalidInput("invalid refusal reason"));
    }
    if !(0..=9_007_199_254_740_991).contains(&now_ms) {
        return Err(OwnerOutboxError::InvalidInput("invalid refusal time"));
    }
    validate_digest(&input.update_digest)?;
    let parent = read_parent(tx, &input.outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
    require_workspace(workspace, &parent.binding.workspace_id)?;
    let observed = draft::read_observed_in(tx, &parent.binding)?;
    let entry: Option<(String, bool, Option<String>, Option<String>)> = tx.query_row(
        "SELECT update_digest,pending,accepted_receipt_json,terminal_reason FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2",
        params![input.outbox_id,input.delivery_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional().map_err(read_sql)?;
    let (digest, pending, receipt, reason) = entry.ok_or(OwnerOutboxError::NotFound)?;
    if digest != input.update_digest || receipt.is_some() {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    if !pending {
        return if reason.as_deref() == Some(input.reason.as_str()) {
            Ok(parent.binding)
        } else {
            Err(OwnerOutboxError::ReceiptMismatch)
        };
    }
    let checkpoint_digest = match &observed {
        Some(observed) => observed.checkpoint_digest.clone(),
        None => native_refusal_checkpoint_in_tx(tx, &parent.binding, input)?,
    };
    tx.execute("UPDATE owner_ydoc_outbox_entries SET pending=0,terminal_blob_digest=update_blob_digest,update_blob_digest=NULL,terminal_reason=?3 WHERE outbox_id=?1 AND delivery_id=?2 AND pending=1", params![input.outbox_id,input.delivery_id,input.reason]).map_err(write_sql)?;
    // Retiring the granted head ends its Try again.
    tx.execute("UPDATE owner_ydoc_outboxes SET retry_delivery_id=NULL WHERE outbox_id=?1 AND retry_delivery_id=?2", params![input.outbox_id,input.delivery_id]).map_err(write_sql)?;
    let visible = draft::refuse_dependent_entries_in_tx(tx, &input.outbox_id, &checkpoint_digest)?;
    refresh_pending_in_tx(tx, &input.outbox_id)?;
    if observed.is_some() && parent.state != OwnerOutboxState::Quarantined {
        index_frontmatter_in_tx(
            tx,
            &parent.binding,
            &visible,
            Some(OWNER_DRAFT_REFUSAL_ACTOR),
            None,
            now_ms,
        )?;
    }
    Ok(parent.binding)
}

fn native_refusal_checkpoint_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    input: &OwnerOutboxRefuseInput,
) -> Result<String, OwnerOutboxError> {
    let (append_key, source): (String, String) = tx.query_row(
        "SELECT append_key,native_source_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2 AND native_source_json IS NOT NULL",
        params![input.outbox_id,input.delivery_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(read_sql)?.ok_or(OwnerOutboxError::NotFound)?;
    let source: OwnerOutboxNativeSource =
        serde_json::from_str(&source).map_err(|_| OwnerOutboxError::Corrupt)?;
    source.validate(&append_key)?;
    source.verify_retained_row(tx)?;
    if source.binding != *binding || source.update_digest != input.update_digest {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let key = draft::key(binding)?;
    let mut remaining = crate::limits::MAX_YDOC_UPDATE_BYTES;
    let (active, namespace, accepted) =
        crate::live_update_application::read_native_accepted_in(tx, &key, &mut remaining)
            .map_err(|_| OwnerOutboxError::ParentMismatch)?
            .ok_or(OwnerOutboxError::NotFound)?;
    if active != *binding {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let adoption = crate::live_update_application::owner_activations::current_activation(
        tx,
        Some(namespace.as_str()),
        &key,
        &binding.lineage_claim_id,
    )
    .map_err(|_| OwnerOutboxError::Corrupt)?
    .map(|(activation, _)| activation.activation_id);
    if adoption.as_deref() != Some(source.adoption_id.as_str()) {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2)",
        params![namespace,input.delivery_id], |r| r.get(0),
    ).map_err(read_sql)?;
    if applied {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    let bytes = accepted
        .encode_full_state_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
        .ok_or(OwnerOutboxError::Corrupt)?;
    dohc_engine_storage::put_binary_blob(tx, &bytes).map_err(OwnerOutboxError::Storage)
}

fn refresh_pending_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
) -> Result<(), OwnerOutboxError> {
    tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=(SELECT COALESCE(SUM(byte_length),0) FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1),oldest_entry_at_ms=(SELECT MIN(created_at_ms) FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1),state=CASE WHEN state='sealed' AND NOT EXISTS (SELECT 1 FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1) THEN 'active' ELSE state END WHERE outbox_id=?1", [outbox_id]).map_err(write_sql)?;
    Ok(())
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
    retry_delivery_id: Option<String>,
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
    draft::require_ordinary_write(tx, &key).map_err(map_restore_error)?;
    let current = crate::live_update_application::restore_fence::resumed_binding(tx, &key)
        .map_err(map_restore_error)?;
    if current
        .as_ref()
        .is_some_and(|binding| binding != &input.binding)
    {
        return Err(OwnerOutboxError::Frozen);
    };
    append_with_retained_base(tx, workspace_id, input, None, None, None, None, false)
}

/// An append key names one exact entry: its binding, base, bytes, whether it
/// is a draft, and its agent declaration. A retry that changes any of them,
/// including adding or removing the declaration, refuses instead of returning
/// the first entry. Only an enrolled owner's draft carries
/// `draft_revision`, the observed binding revision it was queued under. Its
/// editor's declaration, or an adopted native update's recorded agent, rides
/// in `agent_declaration`.
#[allow(clippy::too_many_arguments)]
fn append_with_retained_base(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: OwnerOutboxAppendInput,
    retained_base: Option<(String, i64)>,
    draft_revision: Option<i64>,
    agent_declaration: Option<&AgentDeclaration>,
    automation_declaration: Option<&AutomationDeclaration>,
    person_edit: bool,
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
        &format!("SELECT binding_json,max_pending_bytes,max_pending_age_ms FROM {CURRENT_ACTIVATIONS} WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4"),
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
        } else {
            // A released lineage takes no owner delivery, and no limits bound
            // one, until a successor activation holds it.
            let released: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_owner_activations WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
                params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id],
                |row| row.get(0),
            ).map_err(read_sql)?;
            if released {
                return Err(OwnerOutboxError::Frozen);
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
    if draft_revision.is_some_and(|revision| revision < 1) {
        return Err(OwnerOutboxError::InvalidInput(
            "invalid draft binding revision",
        ));
    }
    let declaration_json = agent_declaration
        .map(|declaration| {
            declaration
                .validate()
                .map_err(OwnerOutboxError::InvalidInput)?;
            serde_json::to_string(declaration).map_err(|_| OwnerOutboxError::Corrupt)
        })
        .transpose()?;
    if agent_declaration.is_some() && automation_declaration.is_some() {
        return Err(OwnerOutboxError::InvalidInput(
            "a draft declares one author kind",
        ));
    }
    let automation_json = automation_declaration
        .map(|d| {
            d.validate().map_err(OwnerOutboxError::InvalidInput)?;
            serde_json::to_string(d).map_err(|_| OwnerOutboxError::Corrupt)
        })
        .transpose()?;
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
        existing_declaration_json,
        existing_draft_revision,
        existing_automation_json,
        terminal_reason,
        existing_person_edit,
    )) = tx
        .query_row(
            "SELECT outbox_id,sequence,delivery_id,update_digest,result_pending_bytes,\
                 result_oldest_entry_at_ms,result_state,agent_declaration_json,\
                 draft_binding_revision,automation_declaration_json,terminal_reason,person_edit \
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
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<bool>>(11)?,
                ))
            },
        )
        .optional()
        .map_err(read_sql)?
    {
        let parent = read_parent(tx, &existing_outbox_id)?.ok_or(OwnerOutboxError::Corrupt)?;
        // A draft's revision advances with each accepted frame, so a retry
        // matches on being a draft, not on the revision it was queued under.
        if parent.binding != binding
            || parent.base_update_digest != base_update_digest
            || existing_update_digest != update_digest
            || existing_declaration_json != declaration_json
            || existing_person_edit != person_edit.then_some(true)
            || existing_automation_json != automation_json
            || existing_draft_revision.is_some() != draft_revision.is_some()
        {
            return Err(OwnerOutboxError::AppendKeyMismatch);
        }
        if terminal_reason.is_some() {
            return Err(OwnerOutboxError::Frozen);
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
            let conflicting: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND (?6=0 OR state!='quarantined' OR pending_bytes!=0))",
                params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation,draft_revision.is_some()], |r| r.get(0),
            ).map_err(read_sql)?;
            if conflicting {
                return Err(OwnerOutboxError::ParentMismatch);
            }
            if retained_base.is_none() {
                put_binary_blob_with_sha(tx, &input.base_update, &base_update_digest)?;
            }
            insert_outbox(
                tx,
                &outbox_id,
                &binding,
                &base_update_digest,
                base_byte_length,
                input.created_at_ms,
            )?;
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
              result_oldest_entry_at_ms,result_state,agent_declaration_json,\
              draft_binding_revision,automation_declaration_json,person_edit) \
             VALUES (?1,?2,?3,?4,?5,?5,?6,?7,1,?8,?9,?10,?11,?12,?13,?14)",
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
            declaration_json,
            draft_revision,
            automation_json,
            person_edit.then_some(true),
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

/// Keeps native work a restore fenced in its generation's queue, which no
/// longer takes edits. The queue keeps its state: a refusal stays, with its
/// head, and a sealed queue stays sealed. Only a Stop's release or a recovery
/// copy reaches the work. Only owner enrollment gets here, which a configured
/// live host refuses, so a queue the service host kept refused never grows.
fn retain_fenced_in_tx(
    tx: &rusqlite::Transaction<'_>,
    parent: &ParentRow,
    draft_revision: i64,
    append_key: &str,
    update: &[u8],
    created_at_ms: i64,
) -> Result<(), OwnerOutboxError> {
    validate_identifier(append_key, "append key must be non-empty and bounded")?;
    if parent.state == OwnerOutboxState::Active {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if update.is_empty() || update.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
        return Err(OwnerOutboxError::InvalidInput("invalid draft update size"));
    }
    let update_digest = hex_sha256(update);
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT outbox_id,update_digest FROM owner_ydoc_outbox_entries WHERE append_key=?1",
            [append_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    if let Some((outbox_id, digest)) = existing {
        return if outbox_id == parent.outbox_id && digest == update_digest {
            Ok(())
        } else {
            Err(OwnerOutboxError::AppendKeyMismatch)
        };
    }
    let byte_length = i64::try_from(update.len())
        .map_err(|_| OwnerOutboxError::InvalidInput("update is too large"))?;
    let pending_bytes =
        parent
            .pending_bytes
            .checked_add(byte_length)
            .ok_or(OwnerOutboxError::InvalidInput(
                "pending byte count overflow",
            ))?;
    let oldest_entry_at_ms = parent.oldest_entry_at_ms.unwrap_or(created_at_ms);
    let delivery_id = delivery_id(&parent.outbox_id, parent.next_sequence, &update_digest);
    put_binary_blob_with_sha(tx, update, &update_digest)?;
    tx.execute(
        "INSERT INTO owner_ydoc_outbox_entries \
             (outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,\
              byte_length,created_at_ms,pending,result_pending_bytes,\
              result_oldest_entry_at_ms,result_state,draft_binding_revision) \
             VALUES (?1,?2,?3,?4,?5,?5,?6,?7,1,?8,?9,?10,?11)",
        params![
            parent.outbox_id,
            parent.next_sequence,
            append_key,
            delivery_id,
            update_digest,
            byte_length,
            created_at_ms,
            pending_bytes,
            oldest_entry_at_ms,
            // The queue takes no edits, which an append result reports as sealed.
            OwnerOutboxState::Sealed.as_str(),
            draft_revision,
        ],
    )
    .map_err(write_sql)?;
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET pending_bytes=?2,oldest_entry_at_ms=?3,next_sequence=?4 WHERE outbox_id=?1",
        params![
            parent.outbox_id,
            pending_bytes,
            oldest_entry_at_ms,
            parent.next_sequence + 1,
        ],
    )
    .map_err(write_sql)?;
    Ok(())
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
        if has_adopted_owner_in(tx, key)? {
            return Err(CollabError::OwnerOutboxFrozen);
        }
        return Ok(());
    };
    let saved: Option<(String, i64, i64, String)> = tx
        .query_row(
            &format!("SELECT binding_json,max_pending_bytes,max_pending_age_ms,activation_id FROM {CURRENT_ACTIVATIONS}
         WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4"),
            params![key.workspace_id, key.version_id, key.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(read_sql)
        .map_err(map)?;
    let Some((binding_json, max_pending_bytes, max_pending_age_ms, adoption_id)) = saved else {
        if has_adopted_owner_in(tx, key)? {
            return Err(CollabError::OwnerOutboxFrozen);
        }
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
    // The delivery declares the agent the native row recorded. The source
    // derives it, so a retry of this append key declares the same agent.
    let agent_declaration = source.agent_declaration().map_err(map)?;
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
        // Not a draft. The native source keeps this update's authors.
        None,
        agent_declaration.as_ref(),
        None,
        source.person_edit().map_err(map)?,
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
                 byte_length,created_at_ms,agent_declaration_json,automation_declaration_json,person_edit FROM owner_ydoc_outbox_entries \
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
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<bool>>(9)?,
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
                declaration_json,
                automation_json,
                person_edit,
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
                person_edit: person_edit.unwrap_or(false),
                agent_declaration: stored_declaration(declaration_json)?,
                automation_declaration: stored_automation_declaration(automation_json)?,
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
            retry_delivery_id: parent.retry_delivery_id,
        })
    })
}

/// The workspace identity a hosted store was created for: its replication
/// epoch and stream identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedStoreIdentity {
    pub replication_epoch: String,
    pub stream_identity: String,
}

impl HostedStoreIdentity {
    /// Whether the store holds this identity for `workspace_id`, with a hosted replica.
    pub fn held_in(&self, conn: &Connection, workspace_id: &str) -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_identity i JOIN hosted_replicas h \
             ON h.workspace_id=i.workspace_id WHERE i.workspace_id=?1 \
             AND i.replication_epoch=?2 AND i.stream_identity=?3)",
            params![workspace_id, self.replication_epoch, self.stream_identity],
            |row| row.get(0),
        )
    }
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
    read_page(store, workspace_id, None, outbox_id, cursor, max_bytes)
}

/// [`read_pending_page`] of a hosted store opened by its workspace identity.
/// Each page's transaction checks that the store still holds `identity`, and
/// the snapshot includes it, so a cursor of another store's queue reads as changed.
pub fn read_pending_hosted_page(
    store: &EngineStore,
    workspace_id: &str,
    identity: &HostedStoreIdentity,
    outbox_id: &str,
    cursor: Option<OwnerOutboxReadCursor>,
    max_bytes: usize,
) -> Result<OwnerOutboxPageResult, OwnerOutboxError> {
    read_page(
        store,
        workspace_id,
        Some(identity),
        outbox_id,
        cursor,
        max_bytes,
    )
}

fn read_page(
    store: &EngineStore,
    workspace_id: &str,
    identity: Option<&HostedStoreIdentity>,
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
        if let Some(identity) = identity {
            if !identity.held_in(&tx, workspace_id).map_err(read_sql)? {
                return Err(OwnerOutboxError::WorkspaceMismatch);
            }
        }
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
            "retryDeliveryId": parent.retry_delivery_id,
        });
        let snapshot = hex_sha256(&page_json(&match identity {
            None => header.clone(),
            Some(identity) => serde_json::json!([
                &header,
                identity.replication_epoch,
                identity.stream_identity
            ]),
        })?);
        if cursor.as_ref().is_some_and(|cursor| cursor.snapshot != snapshot) {
            return Ok(OwnerOutboxPageResult::ReadChanged);
        }
        let cursor = cursor.unwrap_or(OwnerOutboxReadCursor {
            snapshot,
            part: OwnerOutboxReadPart::Header,
            sequence: 0,
            offset: 0,
        });
        use OwnerOutboxReadPart::{Base, Checkpoint, EntryHeader, Header, Update};
        if matches!(cursor.part, Header | Base | Checkpoint) != (cursor.sequence == 0)
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
                // Outside the snapshot: acceptances advance them while the queue waits.
                let seed = refused_seed_in(&tx, &parent)?;
                header["frozenAtRefusedSeed"] = matches!(seed, RefusedSeed::Frozen(_)).into();
                let checkpoint = checkpoint_in(&tx, &parent, &seed)?.map(|(digest, _)| digest);
                // What a recovery copy must hold, at any restore generation.
                header["recoveryCheckpointDigest"] = checkpoint
                    .clone()
                    .filter(|_| !matches!(seed, RefusedSeed::None))
                    .into();
                header["checkpointDigest"] = checkpoint.into();
                let bytes = page_json(&header)?;
                let (total, digest, bytes) = slice_header(bytes, cursor.offset, max_bytes)?;
                (total, digest, bytes, following_part(Base))
            }
            Base => {
                let bytes = slice_blob(&tx, &parent.base_blob_digest, base_length, cursor.offset, max_bytes)?;
                (base_length, parent.base_update_digest, bytes, next_entry(0)?)
            }
            Checkpoint => {
                // Outside the snapshot, so a checkpoint that moved on, or that this
                // queue's binding no longer holds, changes the read instead of failing it.
                let seed = refused_seed_in(&tx, &parent)?;
                let checkpoint = match checkpoint_in(&tx, &parent, &seed) {
                    Err(OwnerOutboxError::RecoveryCheckpointOutdated) => None,
                    checkpoint => checkpoint?,
                };
                let Some((digest, length)) = checkpoint.filter(|(_, length)| cursor.offset < *length)
                else {
                    return Ok(OwnerOutboxPageResult::ReadChanged);
                };
                let bytes = slice_blob(&tx, &digest, length, cursor.offset, max_bytes)?;
                (length, digest, bytes, None)
            }
            EntryHeader | Update => {
                let entry = tx.query_row(
                    "SELECT append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,agent_declaration_json,automation_declaration_json,person_edit,native_source_json \
                     FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2 AND pending=1",
                    params![outbox_id, cursor.sequence], |row| Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
                        row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<bool>>(8)?, row.get::<_, Option<String>>(9)?,
                    )),
                ).optional().map_err(read_sql)?.ok_or(OwnerOutboxError::InvalidInput("invalid read entry"))?;
                let (append_key, delivery_id, digest, blob_digest, byte_length, created_at_ms, declaration_json, automation_json, person_edit, native_json) = entry;
                if digest != blob_digest || byte_length <= 0 {
                    return Err(OwnerOutboxError::Corrupt);
                }
                if cursor.part == EntryHeader {
                    let mut header = serde_json::json!({
                        "sequence": cursor.sequence, "appendKey": append_key,
                        "deliveryId": delivery_id, "updateDigest": digest,
                        "byteLength": byte_length, "createdAtMs": created_at_ms,
                    });
                    if person_edit == Some(true) { header["personEdit"] = serde_json::json!(true); }
                    // An entry that declared no agent has no field at all.
                    if let Some(declaration) = stored_declaration(declaration_json)? {
                        header["agentDeclaration"] = serde_json::to_value(declaration)
                            .map_err(|_| OwnerOutboxError::Corrupt)?;
                    }
                    if let Some(declaration) = stored_automation_declaration(automation_json)? {
                        header["automationDeclaration"] = serde_json::to_value(declaration).map_err(|_| OwnerOutboxError::Corrupt)?;
                    }
                    // Who this computer recorded as the native update's author. Never authority.
                    let native = native_json
                        .map(|json| serde_json::from_str::<OwnerOutboxSource>(&json))
                        .transpose()
                        .map_err(|_| OwnerOutboxError::Corrupt)?;
                    if let Some(source) = native.as_ref().and_then(OwnerOutboxSource::native) {
                        header["nativeSource"] = serde_json::to_value(source).map_err(|_| OwnerOutboxError::Corrupt)?;
                    }
                    let bytes = page_json(&header)?;
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

pub(crate) fn stored_declaration(
    json: Option<String>,
) -> Result<Option<AgentDeclaration>, OwnerOutboxError> {
    json.map(|json| {
        let declaration: AgentDeclaration =
            serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
        declaration
            .validate()
            .map_err(|_| OwnerOutboxError::Corrupt)?;
        Ok(declaration)
    })
    .transpose()
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

/// The digest and length of the accepted state this queue's pending entries
/// build on: the lineage's checkpoint while it is still of the queue's restore
/// generation, which a rename does not change, or else the one the queue kept
/// when a later generation replaced it. A later generation's checkpoint need
/// not contain them, so it is never offered.
fn accepted_checkpoint_in(
    conn: &Connection,
    outbox_id: &str,
    binding: &LiveObjectBinding,
) -> Result<Option<(String, i64)>, OwnerOutboxError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT checkpoint_digest,binding_json FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![binding.workspace_id, binding.main_version_id, binding.object_id, binding.lineage_claim_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    let current = match row {
        Some((digest, held)) => {
            let held: LiveObjectBinding =
                serde_json::from_str(&held).map_err(|_| OwnerOutboxError::Corrupt)?;
            (held.restore_fence_generation == binding.restore_fence_generation).then_some(digest)
        }
        None => None,
    };
    let digest = match current {
        Some(digest) => digest,
        None => {
            let kept: Option<String> = conn
                .query_row(
                    "SELECT kept_checkpoint_digest FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                    [outbox_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(read_sql)?
                .flatten();
            let Some(digest) = kept else {
                return Ok(None);
            };
            digest
        }
    };
    let length: i64 = conn
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
            [&digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .ok_or(OwnerOutboxError::Corrupt)?;
    Ok(Some((digest, length)))
}

/// Where a queue stands with its owner's adoption seed.
enum RefusedSeed {
    /// It holds no refused seed.
    None,
    /// It holds its owner's refused adoption seed with no Try again granted,
    /// at the restore generation its document's application binding still
    /// has, whose lineage last applied this cursor. Nothing applied on that
    /// lineage since the adoption can settle past the seed, so a recovery copy
    /// must carry it.
    Frozen(i64),
    /// It holds a refused seed of a generation its document left, or whose
    /// binding is gone. The restore fence, or the registration that moved the
    /// binding, kept that generation's final accepted state as its recovery
    /// checkpoint.
    Earlier,
}

/// An adoption seed entry of queue `o` that nothing applied.
const UNAPPLIED_SEED: &str = "EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e WHERE e.outbox_id=o.outbox_id AND e.pending=1
    AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed'
    AND NOT EXISTS(SELECT 1 FROM live_device_update_applications s WHERE s.delivery_id=e.delivery_id))";

fn refused_seed_in(conn: &Connection, parent: &ParentRow) -> Result<RefusedSeed, OwnerOutboxError> {
    if parent.state != OwnerOutboxState::Quarantined || parent.retry_delivery_id.is_some() {
        return Ok(RefusedSeed::None);
    }
    let seeded: bool = conn
        .query_row(
            &format!("SELECT {UNAPPLIED_SEED} FROM owner_ydoc_outboxes o WHERE o.outbox_id=?1"),
            [&parent.outbox_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if !seeded {
        return Ok(RefusedSeed::None);
    }
    Ok(applied_cursor_in(conn, &parent.binding)?.map_or(RefusedSeed::Earlier, RefusedSeed::Frozen))
}

/// The last applied cursor of `binding`'s lineage while its document's
/// application binding is still on that lineage and restore generation.
fn applied_cursor_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<i64>, OwnerOutboxError> {
    crate::live_update_application::read_native_applied_cursor_in(conn, binding).map_err(|error| {
        match error {
            crate::live_update_application::ApplicationError::Storage(error) => {
                OwnerOutboxError::Storage(error)
            }
            _ => OwnerOutboxError::ParentMismatch,
        }
    })
}

/// The checkpoint a read of this queue names. A frozen lineage's is the
/// recovery checkpoint built at its current applied cursor, which only the
/// writer builds, so a missing or older one is out of date. An earlier
/// generation's is the one kept as it ended, served only if nothing was
/// applied on it after; no other checkpoint stands in for it.
fn checkpoint_in(
    conn: &Connection,
    parent: &ParentRow,
    seed: &RefusedSeed,
) -> Result<Option<(String, i64)>, OwnerOutboxError> {
    let (digest, built): (Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT recovery_checkpoint_digest,recovery_checkpoint_cursor FROM owner_ydoc_outboxes WHERE outbox_id=?1",
            [&parent.outbox_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    let digest = match (seed, digest) {
        (RefusedSeed::Frozen(cursor), digest) => {
            require_no_deferred_in(conn, &parent.binding)?;
            digest
                .filter(|_| built == Some(*cursor))
                .ok_or(OwnerOutboxError::RecoveryCheckpointOutdated)?
        }
        (RefusedSeed::Earlier, digest) => match (digest, built) {
            (Some(digest), Some(built)) if !applied_after_in(conn, &parent.binding, built)? => {
                digest
            }
            _ => return Err(OwnerOutboxError::RecoveryCheckpointUnavailable),
        },
        (RefusedSeed::None, _) => {
            return accepted_checkpoint_in(conn, &parent.outbox_id, &parent.binding);
        }
    };
    let length: i64 = conn
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
            [&digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .ok_or(OwnerOutboxError::Corrupt)?;
    Ok(Some((digest, length)))
}

/// Whether an update was applied on `binding`'s lineage and restore
/// generation after `cursor`, through any relay.
fn applied_after_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    cursor: i64,
) -> Result<bool, OwnerOutboxError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND journal_cursor>?6)",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            binding.restore_fence_generation,
            cursor
        ],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// A copy of the accepted state would miss an accepted update that still
/// waits on a missing dependency, so none may wait on the document.
fn require_no_deferred_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<(), OwnerOutboxError> {
    let waiting: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![binding.workspace_id, binding.main_version_id, binding.object_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if waiting {
        return Err(OwnerOutboxError::AcceptedStateIncomplete);
    }
    Ok(())
}

/// Builds the recovery checkpoint of a queue frozen at its lineage's refused
/// adoption seed. Changes nothing for any other queue.
pub fn prepare_recovery_checkpoint(
    store: &mut EngineStore,
    workspace_id: &str,
    outbox_id: &str,
) -> Result<(), OwnerOutboxError> {
    validate_identifier(outbox_id, "outbox id must be non-empty and bounded")?;
    let outcome = store.write_with(&NoFaults, |tx| {
        let parent = read_parent(tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        match refused_seed_in(tx, &parent)? {
            RefusedSeed::Frozen(cursor) => build_recovery_checkpoint_in(tx, &parent, cursor),
            _ => Ok(()),
        }
    })?;
    committed(outcome)
}

/// Before a restore fence or a registration moves `binding`'s document off
/// its lineage or generation, while its last applied cursor is final, keeps
/// that accepted state as the recovery checkpoint of each of its queues
/// holding an adoption seed nothing applied. A copy of such a queue reads it
/// once the binding moved on.
pub(crate) fn keep_recovery_checkpoints_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
) -> Result<(), OwnerOutboxError> {
    let outboxes = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT outbox_id FROM owner_ydoc_outboxes o WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND {UNAPPLIED_SEED}"
            ))
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![
                    binding.workspace_id,
                    binding.main_version_id,
                    binding.object_id,
                    binding.lineage_claim_id,
                    binding.restore_fence_generation
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    for outbox_id in outboxes {
        let parent = read_parent(tx, &outbox_id)?.ok_or(OwnerOutboxError::Corrupt)?;
        let cursor =
            applied_cursor_in(tx, &parent.binding)?.ok_or(OwnerOutboxError::ParentMismatch)?;
        build_recovery_checkpoint_in(tx, &parent, cursor)?;
    }
    Ok(())
}

/// Each accepted record is bounded on its own, and the writer rebuilds one
/// recovery checkpoint at a time.
const RECOVERY_RECONSTRUCTION: crate::live_update_application::NativeHistoryReconstruction =
    crate::live_update_application::NativeHistoryReconstruction {
        working_reserve_bytes: 8 * 1024 * 1024,
    };

/// The accepted frames applied on the queue's lineage and generation through
/// `cursor`, and never an outbox entry, as its recovery checkpoint. It is
/// built once per cursor, so every page of a read slices the same bytes; a
/// newer cursor replaces it. Refused while an applied update waits on a
/// missing dependency.
fn build_recovery_checkpoint_in(
    tx: &rusqlite::Transaction<'_>,
    parent: &ParentRow,
    cursor: i64,
) -> Result<(), OwnerOutboxError> {
    require_no_deferred_in(tx, &parent.binding)?;
    let (previous, built): (Option<String>, Option<i64>) = tx
        .query_row(
            "SELECT recovery_checkpoint_digest,recovery_checkpoint_cursor FROM owner_ydoc_outboxes WHERE outbox_id=?1",
            [&parent.outbox_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    if built == Some(cursor) {
        return Ok(());
    }
    let (through, accepted) = crate::live_update_application::read_native_accepted_cut_in(
        tx,
        &parent.binding,
        RECOVERY_RECONSTRUCTION,
    )
    .map_err(|error| match error {
        crate::live_update_application::ApplicationError::AcceptedStateIncomplete => {
            OwnerOutboxError::AcceptedStateIncomplete
        }
        crate::live_update_application::ApplicationError::Storage(error) => {
            OwnerOutboxError::Storage(error)
        }
        _ => OwnerOutboxError::ParentMismatch,
    })?
    .ok_or(OwnerOutboxError::ParentMismatch)?;
    if through != cursor {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let bytes = accepted
        .encode_full_state_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
        .ok_or(OwnerOutboxError::Corrupt)?;
    let digest =
        dohc_engine_storage::put_binary_blob(tx, &bytes).map_err(OwnerOutboxError::Storage)?;
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET recovery_checkpoint_digest=?2,recovery_checkpoint_cursor=?3 WHERE outbox_id=?1",
        params![parent.outbox_id, digest, cursor],
    )
    .map_err(write_sql)?;
    if let Some(previous) = previous.filter(|previous| *previous != digest) {
        delete_binary_blob_if_unreferenced(tx, &previous)?;
    }
    Ok(())
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
    validate_receipts(receipts)?;
    let outcome = store.write_with(&NoFaults, |tx| -> Result<_, OwnerOutboxError> {
        let parent = read_parent(tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
        require_workspace(workspace_id, &parent.binding.workspace_id)?;
        require_unfrozen(&parent, receipts)?;
        let observed = draft::read_observed_in(tx, &parent.binding)?.is_some();
        if observed && accepted::check_release_in(tx, &parent, receipts)? {
            return Ok(OwnerOutboxAcknowledgeResult {
                acknowledged: receipts.len() as i64,
                pending_bytes: parent.pending_bytes,
                oldest_entry_at_ms: parent.oldest_entry_at_ms,
            });
        }
        let result = acknowledge_prefix_in(tx, &parent, receipts)?;
        if observed {
            accepted::prune_in(tx, &parent.binding)?;
        }
        Ok(result)
    })?;
    committed(outcome)
}

fn validate_receipts(receipts: &[OwnerDeliveryReceipt]) -> Result<(), OwnerOutboxError> {
    if receipts.is_empty() {
        return Err(OwnerOutboxError::InvalidInput("receipts must not be empty"));
    }
    let mut delivery_ids = BTreeSet::new();
    for receipt in receipts {
        if !delivery_ids.insert(&receipt.delivery_id) {
            return Err(OwnerOutboxError::ReceiptMismatch);
        }
        validate_receipt(receipt)?;
    }
    Ok(())
}

fn validate_receipt(receipt: &OwnerDeliveryReceipt) -> Result<(), OwnerOutboxError> {
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
    Ok(())
}

/// Acknowledge the pending prefix of `outbox_id` that `receipts` name, in
/// order, keeping each receipt. Every receipt must name its entry's exact
/// delivery and digest. Only a retirement calls this, with receipts the
/// relay's journal proved, so a quarantined outbox accepts them too: its
/// freeze stops delivery, and a Try again whose grant ended may have been
/// accepted before its acknowledgement was lost.
pub(crate) fn acknowledge_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    receipts: &[OwnerDeliveryReceipt],
) -> Result<OwnerOutboxAcknowledgeResult, OwnerOutboxError> {
    validate_receipts(receipts)?;
    let parent = read_parent(tx, outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
    acknowledge_prefix_in(tx, &parent, receipts)
}

/// A quarantined outbox accepts only the head its owner asked to try again.
fn require_unfrozen(
    parent: &ParentRow,
    receipts: &[OwnerDeliveryReceipt],
) -> Result<(), OwnerOutboxError> {
    if parent.state == OwnerOutboxState::Quarantined
        && (receipts.len() != 1
            || parent.retry_delivery_id.as_deref() != Some(receipts[0].delivery_id.as_str()))
    {
        return Err(OwnerOutboxError::Frozen);
    }
    Ok(())
}

/// Keep the missing receipt of an entry that was acknowledged before
/// receipts were kept. An entry that already keeps this exact receipt writes
/// nothing, and any other entry refuses.
pub(crate) fn record_missing_receipt_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    receipt: &OwnerDeliveryReceipt,
) -> Result<(), OwnerOutboxError> {
    validate_receipt(receipt)?;
    let json = serde_json::to_string(receipt).map_err(|_| OwnerOutboxError::Corrupt)?;
    let entry: Option<(String, bool, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT update_digest,pending,accepted_receipt_json,terminal_reason FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2",
            params![outbox_id, receipt.delivery_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(read_sql)?;
    let (digest, pending, saved, terminal) = entry.ok_or(OwnerOutboxError::NotFound)?;
    if digest != receipt.update_digest || pending || terminal.is_some() {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    match saved {
        Some(saved) if saved == json => Ok(()),
        Some(_) => Err(OwnerOutboxError::ReceiptMismatch),
        None => {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=?3 WHERE outbox_id=?1 AND delivery_id=?2 AND pending=0 AND accepted_receipt_json IS NULL",
                params![outbox_id, receipt.delivery_id, json],
            )
            .map_err(write_sql)?;
            Ok(())
        }
    }
}

/// The terminal reason of an adoption seed its released activation never
/// delivered. The reason alone proves nothing; the caller validates the seed.
pub(crate) const ACTIVATION_RELEASED: &str = "activation-released";

/// Retire a pending adoption seed the caller proved was never delivered. It
/// keeps no receipt and no bytes, and the totals count it no longer.
pub(crate) fn abandon_seed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    sequence: i64,
) -> Result<(), OwnerOutboxError> {
    let abandoned: Option<(String, String)> = tx
        .query_row(
            "UPDATE owner_ydoc_outbox_entries SET pending=0,accepted_receipt_json=NULL,update_blob_digest=NULL,\
             terminal_blob_digest=NULL,terminal_reason=?3 WHERE outbox_id=?1 AND sequence=?2 AND pending=1 \
             AND accepted_receipt_json IS NULL RETURNING update_digest,delivery_id",
            params![outbox_id, sequence, ACTIVATION_RELEASED],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(write_sql)?;
    let (digest, delivery_id) = abandoned.ok_or(OwnerOutboxError::ReceiptMismatch)?;
    // Abandoning the granted head ends its Try again.
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET retry_delivery_id=NULL WHERE outbox_id=?1 AND retry_delivery_id=?2",
        params![outbox_id, delivery_id],
    )
    .map_err(write_sql)?;
    refresh_pending_in_tx(tx, outbox_id)?;
    delete_binary_blob_if_unreferenced(tx, &digest)
}

/// The terminal reason of a refused entry a retirement kept: the relay's
/// journal proved it absent, and nothing can deliver it again.
pub(crate) const RETIREMENT_KEPT: &str = "retirement-kept";

/// Retire a pending entry of a quarantined outbox the relay refused, which
/// the caller proved was never accepted. Like a host refusal, it keeps the
/// entry's bytes, and the outbox stays quarantined with its refusals and
/// checkpoints.
pub(crate) fn keep_refused_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    sequence: i64,
) -> Result<(), OwnerOutboxError> {
    let kept = tx
        .execute(
            "UPDATE owner_ydoc_outbox_entries SET pending=0,terminal_blob_digest=update_blob_digest,update_blob_digest=NULL,\
             terminal_reason=?3 WHERE outbox_id=?1 AND sequence=?2 AND pending=1 AND accepted_receipt_json IS NULL \
             AND update_blob_digest=update_digest",
            params![outbox_id, sequence, RETIREMENT_KEPT],
        )
        .map_err(write_sql)?;
    if kept != 1 {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    refresh_pending_in_tx(tx, outbox_id)
}

fn acknowledge_prefix_in(
    tx: &rusqlite::Transaction<'_>,
    parent: &ParentRow,
    receipts: &[OwnerDeliveryReceipt],
) -> Result<OwnerOutboxAcknowledgeResult, OwnerOutboxError> {
    let outbox_id = parent.outbox_id.as_str();
    let mut statement = tx
        .prepare(
            "SELECT sequence,delivery_id,update_digest,byte_length \
             FROM owner_ydoc_outbox_entries \
             WHERE outbox_id=?1 AND pending=1 ORDER BY sequence",
        )
        .map_err(read_sql)?;
    let rows = statement
        .query_map([outbox_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(read_sql)?;
    let prefix = rows
        .take(receipts.len())
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    if prefix.len() != receipts.len()
        || prefix
            .iter()
            .zip(receipts)
            .any(|((_, delivery_id, digest, _), receipt)| {
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
    // Every acknowledgement keeps its receipt, observed or not: a cleared
    // entry alone does not prove the relay accepted it.
    for receipt in receipts {
        tx.execute("UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=?3 WHERE outbox_id=?1 AND delivery_id=?2 AND pending=1",
            params![outbox_id,receipt.delivery_id,serde_json::to_string(receipt).map_err(|_|OwnerOutboxError::Corrupt)?]).map_err(write_sql)?;
    }
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
    // Accepting the granted head ends the quarantine and resumes delivery.
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET pending_bytes=?2,oldest_entry_at_ms=?3, \
         quarantine_reason=CASE WHEN state='quarantined' THEN NULL ELSE quarantine_reason END, \
         state=CASE WHEN state='quarantined' OR (state='sealed' AND ?2=0) THEN 'active' ELSE state END, \
         retry_delivery_id=NULL WHERE outbox_id=?1",
        params![outbox_id, pending_bytes, oldest_entry_at_ms],
    )
    .map_err(write_sql)?;
    // Every refusal recorded here was of a head this acknowledgement passed.
    tx.execute(
        "DELETE FROM owner_ydoc_outbox_refusals WHERE outbox_id=?1",
        [outbox_id],
    )
    .map_err(write_sql)?;
    Ok(OwnerOutboxAcknowledgeResult {
        acknowledged: i64::try_from(receipts.len())
            .map_err(|_| OwnerOutboxError::InvalidInput("too many receipts"))?,
        pending_bytes,
        oldest_entry_at_ms,
    })
}

pub fn quarantine(
    store: &mut EngineStore,
    workspace_id: &str,
    input: OwnerOutboxQuarantineInput,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let outcome = store.write_with(&NoFaults, |tx| {
        quarantine_in_tx(tx, workspace_id, &input, now_ms)
    })?;
    committed(outcome)
}

/// Quarantine and its visible-field rollback share the caller's transaction.
pub(crate) fn quarantine_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerOutboxQuarantineInput,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    if !(0..=9_007_199_254_740_991).contains(&now_ms) {
        return Err(OwnerOutboxError::InvalidInput("invalid quarantine time"));
    }
    validate_identifier(&input.outbox_id, "outbox id must be non-empty and bounded")?;
    validate_identifier(
        &input.reason,
        "quarantine reason must be non-empty and bounded",
    )?;
    let observed_binding = input
        .observed_binding
        .clone()
        .map(|binding| binding.normalized().map_err(OwnerOutboxError::InvalidInput))
        .transpose()?;
    let observed_binding_json = observed_binding.as_ref().map(binding_json).transpose()?;
    let parent = read_parent(tx, &input.outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
    require_workspace(workspace_id, &parent.binding.workspace_id)?;
    if parent.state != OwnerOutboxState::Quarantined {
        // Only the current observed generation owns the draft field index.
        let current_observation: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND binding_json=?5)",
                params![parent.binding.workspace_id, parent.binding.main_version_id, parent.binding.object_id, parent.binding.lineage_claim_id, binding_json(&parent.binding)?],
                |row| row.get(0),
            )
            .map_err(read_sql)?;
        if current_observation {
            // A host can advance native state without updating its retained observation.
            let native =
                crate::load_doc_in(tx, &draft::key(&parent.binding)?).map_err(draft::collab)?;
            index_frontmatter_in_tx(
                tx,
                &parent.binding,
                &native,
                Some(OWNER_DRAFT_QUARANTINE_ACTOR),
                None,
                now_ms,
            )?;
        }
    }
    // Another refusal uses up the owner's Try again.
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason=?2,\
         observed_binding_json=?3,retry_delivery_id=NULL WHERE outbox_id=?1",
        params![input.outbox_id, input.reason, observed_binding_json],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// Records a terminal refusal of the head: the reason and the end of its Try
/// again commit together. Writing any refusal of the head again, or one whose
/// head was accepted or whose Try again already ended, changes nothing, so a
/// late write cannot use up a later Try again.
pub fn record_refusal(
    store: &mut EngineStore,
    workspace_id: &str,
    input: OwnerOutboxQuarantineInput,
    refusal: OwnerOutboxRefusal,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let outcome = store.write_with(&NoFaults, |tx| {
        record_refusal_in_tx(tx, workspace_id, &input, &refusal, now_ms)
    })?;
    committed(outcome)
}

fn insert_outbox(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    binding: &LiveObjectBinding,
    base_update_digest: &str,
    base_byte_length: i64,
    created_at_ms: i64,
) -> Result<(), OwnerOutboxError> {
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
            serde_json::to_string(&binding.selector_paths).map_err(|_| {
                OwnerOutboxError::InvalidInput("selector paths are not serializable")
            })?,
            binding.restore_fence_generation,
            base_update_digest,
            base_byte_length,
            created_at_ms,
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// Open an empty outbox at a successor's binding, on its lineage's retained
/// base, beside the outboxes its released chain left at earlier paths of the
/// same restore generation. Only successor adoption calls this, once its
/// coverage proved each of them; an ordinary append never opens a second
/// outbox for a generation.
pub(crate) fn open_successor_outbox_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    created_at_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let binding = binding
        .clone()
        .normalized()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let base = &binding.lineage_claim_id;
    let base_byte_length: i64 = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes)",
            [base],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .filter(|length| *length > 0)
        .ok_or(OwnerOutboxError::Corrupt)?;
    if find_parent_for_binding(tx, &binding)?.is_some() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let id = outbox_id(&binding, base, &binding_json(&binding)?);
    insert_outbox(tx, &id, &binding, base, base_byte_length, created_at_ms)
}

pub(crate) fn record_refusal_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerOutboxQuarantineInput,
    refusal: &OwnerOutboxRefusal,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    validate_identifier(&input.outbox_id, "outbox id must be non-empty and bounded")?;
    validate_identifier(
        &refusal.delivery_id,
        "delivery id must be non-empty and bounded",
    )?;
    validate_identifier(&refusal.key, "refusal key must be non-empty and bounded")?;
    let parent = read_parent(tx, &input.outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
    require_workspace(workspace_id, &parent.binding.workspace_id)?;
    let (recorded, head): (bool, Option<String>) = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outbox_refusals \
             WHERE outbox_id=?1 AND refusal_key=?2),(SELECT delivery_id FROM owner_ydoc_outbox_entries \
             WHERE outbox_id=?1 AND pending=1 ORDER BY sequence LIMIT 1)",
            params![input.outbox_id, refusal.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    let refused = Some(refusal.delivery_id.as_str());
    if recorded
        || head.as_deref() != refused
        || (parent.state == OwnerOutboxState::Quarantined
            && parent.retry_delivery_id.as_deref() != refused)
    {
        return Ok(());
    }
    quarantine_in_tx(tx, workspace_id, input, now_ms)?;
    // Only the pending head's refusals can still arrive.
    tx.execute(
        "DELETE FROM owner_ydoc_outbox_refusals WHERE outbox_id=?1 AND delivery_id<>?2",
        params![input.outbox_id, refusal.delivery_id],
    )
    .map_err(write_sql)?;
    tx.execute(
        "INSERT INTO owner_ydoc_outbox_refusals(outbox_id,delivery_id,refusal_key) VALUES(?1,?2,?3)",
        params![input.outbox_id, refusal.delivery_id, refusal.key],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// The owner's Try again: one more delivery attempt of the quarantined head at
/// the binding generation the owner saw. The attempt keeps its delivery
/// identity and goes through ordinary admission. Accepting it resumes
/// delivery; refusing it quarantines the outbox again. Delivery never grants
/// itself an attempt. Returns the granted delivery.
pub fn retry(
    store: &mut EngineStore,
    workspace_id: &str,
    input: OwnerOutboxRetryInput,
) -> Result<String, OwnerOutboxError> {
    let outcome = store.write_with(&NoFaults, |tx| retry_in_tx(tx, workspace_id, &input))?;
    committed(outcome)
}

pub(crate) fn retry_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerOutboxRetryInput,
) -> Result<String, OwnerOutboxError> {
    validate_identifier(&input.outbox_id, "outbox id must be non-empty and bounded")?;
    let binding = input
        .binding
        .clone()
        .normalized()
        .map_err(OwnerOutboxError::InvalidInput)?;
    require_workspace(workspace_id, &binding.workspace_id)?;
    let parent = read_parent(tx, &input.outbox_id)?.ok_or(OwnerOutboxError::NotFound)?;
    require_workspace(workspace_id, &parent.binding.workspace_id)?;
    if parent.binding != binding {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if parent.state != OwnerOutboxState::Quarantined {
        return Err(OwnerOutboxError::NotQuarantined);
    }
    // A moved binding recovers through enrollment; the same head cannot pass.
    if parent.observed_binding.is_some()
        || matches!(
            parent.quarantine_reason.as_deref(),
            Some("stale-binding" | "restore-fenced" | "binding-changed")
        )
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let key = draft::key(&binding)?;
    if release::blocked_in(tx, &key)? {
        return Err(OwnerOutboxError::StopConflict);
    }
    let resumed = crate::live_update_application::restore_fence::resumed_binding(tx, &key)
        .map_err(map_restore_error)?;
    if resumed.as_ref().is_some_and(|current| current != &binding) {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // The observed generation, if any, must still be this one.
    let observed = draft::read_observed_in(tx, &binding)?;
    let adopted: Option<String> = tx
        .query_row(
            "SELECT binding_json FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    if let (Some(saved), None) = (adopted, &resumed) {
        let saved: LiveObjectBinding =
            serde_json::from_str(&saved).map_err(|_| OwnerOutboxError::Corrupt)?;
        if saved != binding {
            return Err(OwnerOutboxError::ParentMismatch);
        }
    }
    let marker = crate::read_marker_in(tx, &key).map_err(draft::collab)?;
    let newer: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND restore_fence_generation>?4)",
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.restore_fence_generation,
            ],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    // The document must still be live at the binding the owner saw.
    if newer
        || (observed.is_some() && marker.is_none())
        || marker.is_some_and(|marker| {
            marker.regime != crate::Regime::Replicated
                || marker.lineage_claim_id.as_deref() != Some(binding.lineage_claim_id.as_str())
                || marker.path.as_deref() != Some(binding.current_path.as_str())
        })
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // A repeated request keeps the outstanding grant.
    if let Some(granted) = parent.retry_delivery_id {
        return Ok(granted);
    }
    let head: String = tx
        .query_row(
            "SELECT delivery_id FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence LIMIT 1",
            [&input.outbox_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .ok_or(OwnerOutboxError::NotFound)?;
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET retry_delivery_id=?2 WHERE outbox_id=?1 AND state='quarantined'",
        params![input.outbox_id, head],
    )
    .map_err(write_sql)?;
    Ok(head)
}

fn read_parent(conn: &Connection, outbox_id: &str) -> Result<Option<ParentRow>, OwnerOutboxError> {
    conn.query_row(
        "SELECT outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,\
         current_path,selector_paths_json,restore_fence_generation,base_update_digest,\
         base_blob_digest,state,pending_bytes,oldest_entry_at_ms,next_sequence,\
         quarantine_reason,observed_binding_json,retry_delivery_id \
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
         quarantine_reason,observed_binding_json,retry_delivery_id \
         FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 \
         AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND current_path=?6 AND selector_paths_json=?7",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            binding.restore_fence_generation,
            binding.current_path,
            serde_json::to_string(&binding.selector_paths).map_err(|_| OwnerOutboxError::Corrupt)?,
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
        retry_delivery_id: row.get(16)?,
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
        crate::CollabError::RestoreFenced | crate::CollabError::OwnerOutboxFrozen => {
            OwnerOutboxError::Frozen
        }
        crate::CollabError::Storage(error) => OwnerOutboxError::Storage(error),
        _ => OwnerOutboxError::Corrupt,
    }
}

pub(crate) fn stored_automation_declaration(
    value: Option<String>,
) -> Result<Option<AutomationDeclaration>, OwnerOutboxError> {
    value
        .map(|json| {
            let declaration: AutomationDeclaration =
                serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
            declaration
                .validate()
                .map_err(|_| OwnerOutboxError::Corrupt)?;
            Ok(declaration)
        })
        .transpose()
}

/// The actor an outbox entry credits, and its attribution.
pub(crate) type EntryCredit = (
    Option<String>,
    Option<dohc_engine_domain::ChangeAttribution>,
);

/// What an outbox entry's evidence credits: a native entry's journal row,
/// whose declarations must be the ones its source derives, or what a draft
/// declared. An automation outranks an agent, and either a person's edit.
/// An adoption seed, and a draft that declared nothing, credit nobody; a
/// caller treats that as unattributed, never as whoever reads the entry.
pub(crate) fn entry_credit(
    native: Option<&OwnerOutboxNativeSource>,
    agent: Option<String>,
    automation: Option<String>,
    person: Option<i64>,
) -> Result<EntryCredit, OwnerOutboxError> {
    let person = match person {
        None => false,
        Some(1) => true,
        Some(_) => return Err(OwnerOutboxError::Corrupt),
    };
    let agent = stored_declaration(agent)?;
    let automation = stored_automation_declaration(automation)?;
    if agent.is_some() && automation.is_some() {
        return Err(OwnerOutboxError::Corrupt);
    }
    if let Some(source) = native {
        if automation.is_some()
            || agent != source.agent_declaration()?
            || person != source.person_edit()?
        {
            return Err(OwnerOutboxError::Corrupt);
        }
        return Ok(source.native_author()?.unwrap_or((None, None)));
    }
    Ok(if let Some(declared) = automation {
        (Some(declared.automation_id), Some(declared.attribution))
    } else if let Some(declared) = agent {
        (
            Some(declared.agent_id.clone()),
            Some(declared.attribution()),
        )
    } else if person {
        (
            Some("local-person".into()),
            Some(dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Human,
                on_behalf_of: None,
                depth: 0,
                run: None,
            }),
        )
    } else {
        (None, None)
    })
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
    fn entry_headers_carry_the_recorded_native_source_and_an_unbound_queue_has_no_checkpoint() {
        let (_dir, mut store) = store("owner-native-source-read");
        let appended = append(&mut store, "workspace-1", input("native", b"a", 1)).expect("append");
        let source = OwnerOutboxNativeSource {
            binding: binding(),
            adoption_id: "adoption-1".to_owned(),
            native_sequence: 3,
            update_digest: appended.update_digest.clone(),
            origin: OwnerOutboxNativeOrigin::NativeUpdate {
                actor_origin_id: Some("automation-1".to_owned()),
                actor_kind: Some("automation".to_owned()),
                on_behalf_of: Some("person-1".to_owned()),
                chain_depth: Some(1),
                recorded_at_ms: 5,
            },
        };
        let json = serde_json::to_string(&source).expect("source");
        committed(
            store
                .write_with(&NoFaults, |tx| -> Result<usize, OwnerOutboxError> {
                    tx.execute(
                        "UPDATE owner_ydoc_outbox_entries SET native_source_json=?2 WHERE outbox_id=?1",
                        params![appended.outbox_id, json],
                    )
                    .map_err(write_sql)
                })
                .expect("recorded source"),
        )
        .expect("recorded source committed");
        let header = page(&store, &appended.outbox_id, None, 4096);
        let raw: serde_json::Value = serde_json::from_slice(&header.bytes).expect("header");
        assert!(raw["checkpointDigest"].is_null());
        assert_eq!(raw["frozenAtRefusedSeed"], serde_json::json!(false));
        let first: OwnerOutboxReadCursor =
            serde_json::from_value(raw["firstEntryCursor"].clone()).expect("first entry");
        let entry = page(&store, &appended.outbox_id, Some(first), 4096);
        let entry: serde_json::Value = serde_json::from_slice(&entry.bytes).expect("entry header");
        assert_eq!(
            entry["nativeSource"],
            serde_json::to_value(&source).expect("source json")
        );
        let checkpoint = OwnerOutboxReadCursor {
            snapshot: header.cursor.snapshot.clone(),
            part: OwnerOutboxReadPart::Checkpoint,
            sequence: 0,
            offset: 0,
        };
        // As for a checkpoint that moved on: the read changed instead of failing.
        assert!(matches!(
            read_pending_page(
                &store,
                "workspace-1",
                &appended.outbox_id,
                Some(checkpoint),
                4096
            ),
            Ok(OwnerOutboxPageResult::ReadChanged)
        ));
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
                        20,
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
            20,
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

    fn refused_queue(tag: &str) -> (ScratchDir, EngineStore, String, OwnerOutboxPending) {
        let (dir, mut store) = store(tag);
        let outbox = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("first")
            .outbox_id;
        append(&mut store, "workspace-1", input("key-2", b"two", 11)).expect("second");
        append(&mut store, "workspace-1", input("key-3", b"three", 12)).expect("third");
        refuse(&mut store, &outbox);
        let pending = read_pending(&store, "workspace-1", &outbox).expect("quarantined");
        (dir, store, outbox, pending)
    }

    fn refuse(store: &mut EngineStore, outbox: &str) {
        quarantine(
            store,
            "workspace-1",
            OwnerOutboxQuarantineInput {
                outbox_id: outbox.to_owned(),
                reason: "invalid-update".to_owned(),
                observed_binding: None,
            },
            20,
        )
        .expect("quarantine");
    }

    fn try_again(outbox: &str) -> OwnerOutboxRetryInput {
        OwnerOutboxRetryInput {
            outbox_id: outbox.to_owned(),
            binding: binding(),
        }
    }

    #[test]
    fn try_again_grants_the_head_one_attempt_whose_acceptance_resumes_delivery() {
        let (_dir, mut store, outbox, pending) = refused_queue("owner-outbox-try-again");
        let [head, second, third] = [0, 1, 2].map(|index| receipt(&pending.entries[index]));
        assert!(matches!(
            acknowledge(
                &mut store,
                "workspace-1",
                &outbox,
                std::slice::from_ref(&head)
            ),
            Err(OwnerOutboxError::Frozen)
        ));
        let granted = retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        assert_eq!(granted, head.delivery_id);
        let held = read_pending(&store, "workspace-1", &outbox).expect("granted");
        assert_eq!(held.state, OwnerOutboxState::Quarantined);
        assert_eq!(held.retry_delivery_id.as_deref(), Some(granted.as_str()));
        // The grant covers the head alone, never its suffix.
        for receipts in [vec![second.clone()], vec![head.clone(), second.clone()]] {
            assert!(matches!(
                acknowledge(&mut store, "workspace-1", &outbox, &receipts),
                Err(OwnerOutboxError::Frozen)
            ));
        }
        acknowledge(&mut store, "workspace-1", &outbox, &[head]).expect("accepted head");
        let resumed = read_pending(&store, "workspace-1", &outbox).expect("resumed");
        assert_eq!(resumed.state, OwnerOutboxState::Active);
        assert_eq!(resumed.quarantine_reason, None);
        assert_eq!(resumed.retry_delivery_id, None);
        assert_eq!(resumed.entries.len(), 2);
        acknowledge(&mut store, "workspace-1", &outbox, &[second, third]).expect("suffix");
        append(&mut store, "workspace-1", input("key-4", b"four", 13)).expect("new edit");
    }

    #[test]
    fn a_repeated_refusal_requarantines_with_its_reason_and_uses_up_the_grant() {
        let (_dir, mut store, outbox, pending) = refused_queue("owner-outbox-try-again-refused");
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        refuse(&mut store, &outbox);
        let frozen = read_pending(&store, "workspace-1", &outbox).expect("refused again");
        assert_eq!(frozen.state, OwnerOutboxState::Quarantined);
        assert_eq!(frozen.quarantine_reason.as_deref(), Some("invalid-update"));
        assert_eq!(frozen.retry_delivery_id, None);
        assert_eq!(frozen.entries, pending.entries);
        assert!(matches!(
            acknowledge(
                &mut store,
                "workspace-1",
                &outbox,
                &[receipt(&pending.entries[0])]
            ),
            Err(OwnerOutboxError::Frozen)
        ));
        // Only another request from the owner opens another attempt.
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again later");
        acknowledge(
            &mut store,
            "workspace-1",
            &outbox,
            &[receipt(&pending.entries[0])],
        )
        .expect("accepted on the second request");
    }

    #[test]
    fn a_granted_attempt_survives_reopen_as_exactly_one_attempt() {
        let (dir, mut store, outbox, pending) = refused_queue("owner-outbox-try-again-reopen");
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 20).expect("reopen granted");
        let granted = read_pending(&store, "workspace-1", &outbox).expect("granted");
        assert_eq!(
            granted.retry_delivery_id.as_deref(),
            Some(pending.entries[0].delivery_id.as_str())
        );
        refuse(&mut store, &outbox);
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 30).expect("reopen refused");
        let frozen = read_pending(&store, "workspace-1", &outbox).expect("refused");
        assert_eq!(frozen.state, OwnerOutboxState::Quarantined);
        assert_eq!(frozen.quarantine_reason.as_deref(), Some("invalid-update"));
        assert_eq!(frozen.retry_delivery_id, None);
        assert_eq!(frozen.entries, pending.entries);
        assert_eq!(frozen.base_update, pending.base_update);
        assert!(matches!(
            acknowledge(
                &mut store,
                "workspace-1",
                &outbox,
                &[receipt(&pending.entries[0])]
            ),
            Err(OwnerOutboxError::Frozen)
        ));
        assert!(matches!(
            append(&mut store, "workspace-1", input("key-4", b"four", 13)),
            Err(OwnerOutboxError::Frozen)
        ));
    }

    fn record(store: &mut EngineStore, outbox: &str, delivery_id: &str, key: &str) {
        record_refusal(
            store,
            "workspace-1",
            OwnerOutboxQuarantineInput {
                outbox_id: outbox.to_owned(),
                reason: "provenance-refused".to_owned(),
                observed_binding: None,
            },
            OwnerOutboxRefusal {
                delivery_id: delivery_id.to_owned(),
                key: key.to_owned(),
            },
            40,
        )
        .expect("record refusal");
    }

    fn recorded_refusals(store: &EngineStore, outbox: &str) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM owner_ydoc_outbox_refusals WHERE outbox_id=?1",
                    [outbox],
                    |row| row.get(0),
                )
            })
            .expect("recorded refusals")
    }

    #[test]
    fn no_earlier_refusal_ends_a_newer_try_again() {
        let (dir, mut store, outbox, pending) = refused_queue("owner-outbox-earlier-refusal");
        let head = pending.entries[0].delivery_id.clone();
        for key in ["refusal-a", "refusal-b"] {
            retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
            record(&mut store, &outbox, &head, key);
            let refused = read_pending(&store, "workspace-1", &outbox).expect("refused");
            assert_eq!(refused.retry_delivery_id, None);
        }
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("newest try again");
        let still_granted = |store: &EngineStore| {
            let granted = read_pending(store, "workspace-1", &outbox).expect("granted");
            assert_eq!(granted.state, OwnerOutboxState::Quarantined);
            assert_eq!(granted.retry_delivery_id.as_deref(), Some(head.as_str()));
            assert_eq!(granted.entries, pending.entries);
        };
        // A write of the first refusal whose completion was delayed.
        record(&mut store, &outbox, &head, "refusal-a");
        still_granted(&store);
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 50).expect("reopen");
        for key in ["refusal-a", "refusal-b", "refusal-a"] {
            record(&mut store, &outbox, &head, key);
            still_granted(&store);
        }
        assert_eq!(recorded_refusals(&store, &outbox), 2);
        acknowledge(
            &mut store,
            "workspace-1",
            &outbox,
            &[receipt(&pending.entries[0])],
        )
        .expect("accepted");
        assert_eq!(recorded_refusals(&store, &outbox), 0);
    }

    #[test]
    fn a_moved_head_and_a_released_queue_keep_no_earlier_refusal() {
        let (_dir, mut store, outbox, pending) = refused_queue("owner-outbox-refusal-cleanup");
        let [first, second] = [0, 1].map(|index| pending.entries[index].delivery_id.clone());
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        acknowledge(
            &mut store,
            "workspace-1",
            &outbox,
            &[receipt(&pending.entries[0])],
        )
        .expect("first head accepted");
        // A refusal still kept for the earlier head.
        committed(
            store
                .write_with(&NoFaults, |tx| -> Result<usize, OwnerOutboxError> {
                    tx.execute(
                        "INSERT INTO owner_ydoc_outbox_refusals(outbox_id,delivery_id,refusal_key) VALUES(?1,?2,'refusal-first')",
                        params![outbox, first],
                    )
                    .map_err(write_sql)
                })
                .expect("earlier refusal"),
        )
        .expect("earlier refusal committed");
        record(&mut store, &outbox, &second, "refusal-second");
        let kept: Vec<String> = store
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT delivery_id FROM owner_ydoc_outbox_refusals WHERE outbox_id=?1",
                )?;
                let rows = statement.query_map([&outbox], |row| row.get(0))?;
                rows.collect::<Result<Vec<_>, rusqlite::Error>>()
            })
            .expect("kept refusals");
        assert_eq!(kept, vec![second]);
        // Release deletes the queue's rows; the refusals go with them.
        committed(
            store
                .write_with(&NoFaults, |tx| -> Result<(), OwnerOutboxError> {
                    tx.execute(
                        "DELETE FROM owner_ydoc_outbox_entries WHERE outbox_id=?1",
                        [&outbox],
                    )
                    .map_err(write_sql)?;
                    tx.execute(
                        "DELETE FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                        [&outbox],
                    )
                    .map_err(write_sql)?;
                    Ok(())
                })
                .expect("released"),
        )
        .expect("release committed");
        assert_eq!(recorded_refusals(&store, &outbox), 0);
    }

    #[test]
    fn a_granted_try_again_keeps_its_document_loaded_until_an_outcome_uses_it_up() {
        let (_dir, mut store, outbox, _pending) = refused_queue("owner-outbox-unload-grant");
        let pending = |store: &EngineStore| {
            store
                .read_with(|conn| {
                    crate::live_update_application::unload_pending(conn, "workspace-1", "object-1")
                })
                .expect("unload pending")
        };
        // A refused queue waits for its owner, not for delivery.
        assert_eq!(pending(&store), None);
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        assert_eq!(
            pending(&store),
            Some(crate::live_update_application::UnloadPending::Delivery)
        );
        // Refused again, the grant is used up.
        refuse(&mut store, &outbox);
        assert_eq!(pending(&store), None);
    }

    #[test]
    fn a_repeated_try_again_keeps_the_outstanding_grant() {
        let (_dir, mut store, outbox, pending) = refused_queue("owner-outbox-try-again-twice");
        let first = retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        let second = retry(&mut store, "workspace-1", try_again(&outbox)).expect("again");
        assert_eq!(first, pending.entries[0].delivery_id);
        assert_eq!(second, first);
    }

    #[test]
    fn a_recorded_refusal_ends_its_try_again_once_and_never_a_later_one() {
        let (dir, mut store, outbox, pending) = refused_queue("owner-outbox-known-refusal");
        let head = pending.entries[0].delivery_id.clone();
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again");
        record(&mut store, &outbox, &head, "refusal-1");
        let frozen = read_pending(&store, "workspace-1", &outbox).expect("refused");
        assert_eq!(frozen.state, OwnerOutboxState::Quarantined);
        assert_eq!(
            frozen.quarantine_reason.as_deref(),
            Some("provenance-refused")
        );
        assert_eq!(frozen.retry_delivery_id, None);
        assert_eq!(frozen.entries, pending.entries);
        assert_eq!(frozen.base_update, pending.base_update);
        // The owner asks again before a lost response's write is repeated.
        retry(&mut store, "workspace-1", try_again(&outbox)).expect("try again later");
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 50).expect("reopen");
        record(&mut store, &outbox, &head, "refusal-1");
        let granted = read_pending(&store, "workspace-1", &outbox).expect("granted");
        assert_eq!(granted.retry_delivery_id.as_deref(), Some(head.as_str()));
        assert_eq!(
            granted.quarantine_reason.as_deref(),
            Some("provenance-refused")
        );
        // A refusal of another entry than the granted head changes nothing.
        record(
            &mut store,
            &outbox,
            &pending.entries[1].delivery_id,
            "refusal-2",
        );
        assert_eq!(
            read_pending(&store, "workspace-1", &outbox)
                .expect("still granted")
                .retry_delivery_id
                .as_deref(),
            Some(head.as_str())
        );
        acknowledge(
            &mut store,
            "workspace-1",
            &outbox,
            &[receipt(&pending.entries[0])],
        )
        .expect("accepted");
        // A refusal written after its head was accepted cannot freeze the suffix.
        record(&mut store, &outbox, &head, "refusal-3");
        let resumed = read_pending(&store, "workspace-1", &outbox).expect("resumed");
        assert_eq!(resumed.state, OwnerOutboxState::Active);
        assert_eq!(resumed.quarantine_reason, None);
        assert_eq!(resumed.entries.len(), 2);
    }

    #[test]
    fn a_refusal_of_an_active_head_quarantines_the_queue_and_keeps_its_bytes() {
        let (_dir, mut store) = store("owner-outbox-known-refusal-active");
        let first = append(&mut store, "workspace-1", input("key-1", b"one", 10)).expect("first");
        append(&mut store, "workspace-1", input("key-2", b"two", 11)).expect("second");
        let before = read_pending(&store, "workspace-1", &first.outbox_id).expect("active");
        record(
            &mut store,
            &first.outbox_id,
            &first.delivery_id,
            "refusal-1",
        );
        let frozen = read_pending(&store, "workspace-1", &first.outbox_id).expect("frozen");
        assert_eq!(frozen.state, OwnerOutboxState::Quarantined);
        assert_eq!(
            frozen.quarantine_reason.as_deref(),
            Some("provenance-refused")
        );
        assert_eq!(frozen.entries, before.entries);
        assert!(matches!(
            record_refusal(
                &mut store,
                "workspace-2",
                OwnerOutboxQuarantineInput {
                    outbox_id: first.outbox_id.clone(),
                    reason: "provenance-refused".to_owned(),
                    observed_binding: None,
                },
                OwnerOutboxRefusal {
                    delivery_id: first.delivery_id.clone(),
                    key: "refusal-2".to_owned(),
                },
                40,
            ),
            Err(OwnerOutboxError::WorkspaceMismatch)
        ));
    }

    #[test]
    fn stale_try_again_requests_cannot_reopen_the_queue() {
        let (_dir, mut store, outbox, _pending) = refused_queue("owner-outbox-try-again-stale");
        assert!(matches!(
            retry(&mut store, "workspace-2", try_again(&outbox)),
            Err(OwnerOutboxError::WorkspaceMismatch)
        ));
        let mut other_workspace = try_again(&outbox);
        other_workspace.binding.workspace_id = "workspace-2".to_owned();
        assert!(matches!(
            retry(&mut store, "workspace-1", other_workspace),
            Err(OwnerOutboxError::WorkspaceMismatch)
        ));
        let changes: [fn(&mut LiveObjectBinding); 3] = [
            |binding| binding.restore_fence_generation = 8,
            |binding| binding.lineage_claim_id = "lineage-2".to_owned(),
            |binding| binding.current_path = "notes/renamed.md".to_owned(),
        ];
        for change in changes {
            let mut stale = try_again(&outbox);
            change(&mut stale.binding);
            assert!(matches!(
                retry(&mut store, "workspace-1", stale),
                Err(OwnerOutboxError::ParentMismatch)
            ));
        }
        assert!(matches!(
            retry(&mut store, "workspace-1", try_again("owner-outbox-unknown")),
            Err(OwnerOutboxError::NotFound)
        ));
        // A later restore generation makes this one stale.
        let mut successor = input("key-next", b"next", 30);
        successor.binding.restore_fence_generation = 8;
        append(&mut store, "workspace-1", successor).expect("next generation");
        assert!(matches!(
            retry(&mut store, "workspace-1", try_again(&outbox)),
            Err(OwnerOutboxError::ParentMismatch)
        ));
        assert_eq!(
            read_pending(&store, "workspace-1", &outbox)
                .expect("still frozen")
                .retry_delivery_id,
            None
        );
    }

    #[test]
    fn try_again_needs_a_refused_queue_at_an_unmoved_binding() {
        let (_dir, mut store) = store("owner-outbox-try-again-active");
        let active = append(&mut store, "workspace-1", input("key-1", b"one", 10))
            .expect("active")
            .outbox_id;
        assert!(matches!(
            retry(&mut store, "workspace-1", try_again(&active)),
            Err(OwnerOutboxError::NotQuarantined)
        ));
        // A moved binding recovers through enrollment, not another attempt.
        quarantine(
            &mut store,
            "workspace-1",
            OwnerOutboxQuarantineInput {
                outbox_id: active.clone(),
                reason: "restore-fenced".to_owned(),
                observed_binding: Some(binding()),
            },
            20,
        )
        .expect("binding quarantine");
        assert!(matches!(
            retry(&mut store, "workspace-1", try_again(&active)),
            Err(OwnerOutboxError::ParentMismatch)
        ));
        let illegal = store.write_with(&NoFaults, |tx| -> Result<usize, OwnerOutboxError> {
            tx.execute(
                "UPDATE owner_ydoc_outboxes SET state='active',quarantine_reason=NULL,\
                 observed_binding_json=NULL,retry_delivery_id='owner-delivery-x' WHERE outbox_id=?1",
                [&active],
            )
            .map_err(write_sql)
        });
        assert!(
            illegal.is_err(),
            "the schema must refuse a grant on an outbox that is not quarantined"
        );
    }
}
