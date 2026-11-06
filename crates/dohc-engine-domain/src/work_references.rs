//! Work references: one opaque, immutable name for one piece of work in a
//! workspace, made on this device so `@` and Copy link work offline.
//!
//! A reference is 256 random bits in unpadded base64url. It names a target by
//! stable identity: a message id, a file object id, a record id, a Collection's
//! schema file, or a transactional table and record. A path or a name is only
//! display data, so a rename or a move never changes what a reference names.
//! Asking again for the same target on this device returns the same reference.
//! A new reference and its registration outbox entry commit in one
//! transaction, so a crash leaves both or neither.

use crate::DomainError;
use crate::collections::is_record_id;
use crate::store::{get_active_version_in, validate_addressable_plaintext_path};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_storage::{
    EngineStore, FaultInjector, MAX_IDENTIFIER_BYTES, StorageError, TxnOutcome,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

/// The length of a reference: 32 random bytes in unpadded base64url.
pub const WORK_REFERENCE_LENGTH: usize = 43;

/// What a caller asks to reference. A version-scoped target without a
/// `versionId` uses the active version.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkTargetInput {
    Message {
        message_id: String,
    },
    /// Exactly one of `objectId` and `path`.
    File {
        version_id: Option<String>,
        object_id: Option<String>,
        path: Option<String>,
    },
    /// An app is named by its entry file: exactly one of `objectId` and
    /// `path`.
    App {
        version_id: Option<String>,
        object_id: Option<String>,
        path: Option<String>,
    },
    DocumentRecord {
        version_id: Option<String>,
        record_id: String,
    },
    /// `path` is the Collection's folder.
    DocumentCollection {
        version_id: Option<String>,
        path: String,
    },
    TransactionalCollection {
        dataset_id: String,
        table_id: String,
    },
    TransactionalRecord {
        dataset_id: String,
        table_id: String,
        record_id: TransactionalRecordId,
    },
}

/// A transactional record id keeps its JSON type: `7` and `"7"` are different
/// records.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum TransactionalRecordId {
    Number(i64),
    Text(String),
}

/// The stable identity a reference names.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkTarget {
    /// `channelId` is null for a file's conversation.
    Message {
        message_id: String,
        thread_id: String,
        channel_id: Option<String>,
    },
    File {
        version_id: String,
        object_id: String,
    },
    App {
        version_id: String,
        object_id: String,
    },
    DocumentRecord {
        version_id: String,
        record_id: String,
    },
    /// `objectId` is the Collection's schema file.
    DocumentCollection {
        version_id: String,
        object_id: String,
    },
    TransactionalCollection {
        dataset_id: String,
        table_id: String,
    },
    TransactionalRecord {
        dataset_id: String,
        table_id: String,
        record_id: TransactionalRecordId,
    },
}

/// Whether the target still exists here. The dataset host owns transactional
/// data, so the engine leaves those targets `unchecked`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkTargetState {
    Live,
    Deleted,
    Unchecked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkReferenceRegistration {
    Pending,
    Registered,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MadeWorkReference {
    pub reference: String,
    /// False when this device already had a reference for the target.
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkReferenceResolution {
    /// No reference by that name in this workspace.
    Unknown,
    Found {
        reference: String,
        target: WorkTarget,
        state: WorkTargetState,
        /// Where a live file, app, record, or Collection is now. Display only.
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        created_at_ms: i64,
        registration: WorkReferenceRegistration,
    },
}

pub const WORK_REFERENCE_BATCH: usize = 128;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkReferenceMapping {
    pub reference: String,
    pub target: WorkTarget,
    pub created_at_ms: i64,
}

pub fn pending_work_references(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<WorkReferenceMapping>, DomainError> {
    store.read_with(|conn| {
        let mut statement = conn.prepare_cached(
            "SELECT r.reference FROM work_reference_outbox o JOIN work_references r ON r.reference=o.reference \
             WHERE r.workspace_id=?1 ORDER BY o.enqueued_at_ms,o.reference LIMIT ?2",
        ).map_err(DomainError::sql_corrupt)?;
        let references = statement.query_map(params![workspace_id, WORK_REFERENCE_BATCH as i64], |row| row.get::<_, String>(0))
            .map_err(DomainError::sql_corrupt)?;
        let mut mappings = Vec::new();
        for reference in references {
            if let WorkReferenceResolution::Found {reference, target, created_at_ms, ..} =
                resolve_in(conn, workspace_id, &reference.map_err(DomainError::sql_corrupt)?)? {
                mappings.push(WorkReferenceMapping {reference, target, created_at_ms});
            }
        }
        Ok(mappings)
    })
}

pub fn acknowledge_work_references(
    store: &mut EngineStore,
    workspace_id: &str,
    references: &[String],
) -> Result<(), DomainError> {
    if references.len() > WORK_REFERENCE_BATCH {
        return Err(DomainError::InvalidInput {
            reason: "too many work references",
        });
    }
    store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        for reference in references {
            tx.execute(
                "DELETE FROM work_reference_outbox WHERE reference=?1 AND reference IN \
                (SELECT reference FROM work_references WHERE workspace_id=?2)",
                params![reference, workspace_id],
            )
            .map_err(DomainError::sql_persist)?;
        }
        Ok::<_, DomainError>(())
    })?;
    Ok(())
}

pub fn defer_work_reference_registrations(
    store: &mut EngineStore,
    workspace_id: &str,
    references: &[String],
) -> Result<(), DomainError> {
    if references.len() > WORK_REFERENCE_BATCH {
        return Err(DomainError::InvalidInput {
            reason: "too many work references",
        });
    }
    store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        let mut tail: i64 = tx.query_row("SELECT coalesce(max(o.enqueued_at_ms),0) FROM work_reference_outbox o \
            JOIN work_references r ON r.reference=o.reference WHERE r.workspace_id=?1",[workspace_id],|row|row.get(0))
            .map_err(DomainError::sql_corrupt)?;
        for reference in references {
            tail = tail.checked_add(1).ok_or(DomainError::StateCorrupt {reason: "work reference retry order overflow"})?;
            tx.execute("UPDATE work_reference_outbox SET enqueued_at_ms=?1 WHERE reference=?2 AND reference IN \
                (SELECT reference FROM work_references WHERE workspace_id=?3)",params![tail,reference,workspace_id])
                .map_err(DomainError::sql_persist)?;
        }
        Ok::<_,DomainError>(())
    })?;
    Ok(())
}

pub fn learn_work_references(
    store: &mut EngineStore,
    workspace_id: &str,
    mappings: &[WorkReferenceMapping],
) -> Result<(), DomainError> {
    if mappings.len() > WORK_REFERENCE_BATCH {
        return Err(DomainError::InvalidInput {
            reason: "too many work references",
        });
    }
    store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        for mapping in mappings {
            if !is_work_reference(&mapping.reference) { return Err(DomainError::InvalidInput {reason: "invalid work reference"}); }
            if let WorkReferenceResolution::Found {target, ..} = resolve_in(tx, workspace_id, &mapping.reference)? {
                if target != mapping.target { return Err(DomainError::InvalidInput {reason: "work references are immutable"}); }
                continue;
            }
            tx.execute("INSERT INTO learned_work_references(reference,workspace_id,target_json,created_at_ms) VALUES (?1,?2,?3,?4)",
                params![mapping.reference, workspace_id, serde_json::to_string(&mapping.target).map_err(|_| DomainError::StateCorrupt {reason: "invalid work reference target"})?, mapping.created_at_ms])
                .map_err(DomainError::sql_persist)?;
        }
        Ok::<_, DomainError>(())
    })?;
    Ok(())
}

fn learned_row(
    conn: &Connection,
    workspace_id: &str,
    reference: &str,
) -> Result<Option<ReferenceRow>, DomainError> {
    let row: Option<(String, i64)> = conn.query_row(
        "SELECT target_json,created_at_ms FROM learned_work_references WHERE workspace_id=?1 AND reference=?2",
        params![workspace_id, reference], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(DomainError::sql_corrupt)?;
    let Some((json, created)) = row else {
        return Ok(None);
    };
    let target: WorkTarget =
        serde_json::from_str(&json).map_err(|_| DomainError::StateCorrupt {
            reason: "invalid learned work reference",
        })?;
    let binding = match target {
        WorkTarget::Message {
            message_id,
            thread_id,
            channel_id,
        } => Binding {
            thread_id: Some(thread_id),
            channel_id,
            ..Binding::of("message", message_id)
        },
        WorkTarget::File {
            version_id,
            object_id,
        } => Binding::versioned("file", version_id, object_id),
        WorkTarget::App {
            version_id,
            object_id,
        } => Binding::versioned("app", version_id, object_id),
        WorkTarget::DocumentCollection {
            version_id,
            object_id,
        } => Binding::versioned("documentCollection", version_id, object_id),
        WorkTarget::DocumentRecord {
            version_id,
            record_id,
        } => Binding::versioned("documentRecord", version_id, record_id),
        WorkTarget::TransactionalCollection {
            dataset_id,
            table_id,
        } => Binding {
            dataset_id: Some(dataset_id),
            ..Binding::of("transactionalCollection", table_id)
        },
        WorkTarget::TransactionalRecord {
            dataset_id,
            table_id,
            record_id,
        } => Binding {
            dataset_id: Some(dataset_id),
            table_id: Some(table_id),
            ..Binding::of("transactionalRecord", transactional_record_key(&record_id)?)
        },
    };
    Ok(Some((
        binding.kind.to_owned(),
        binding.target_id,
        binding.version_id,
        binding.dataset_id,
        binding.table_id,
        binding.thread_id,
        binding.channel_id,
        created,
        false,
    )))
}

pub fn work_reference_page_after(
    store: &EngineStore,
    workspace_id: &str,
    scope_id: &str,
) -> Result<Option<String>, DomainError> {
    store.read_with(|conn| conn.query_row(
        "SELECT after_reference FROM work_reference_sync_pages WHERE workspace_id=?1 AND scope_id=?2",
        params![workspace_id, scope_id], |row| row.get::<_, Option<String>>(0),
    ).optional().map(|row| row.flatten()).map_err(DomainError::sql_corrupt))
}

pub fn learn_work_reference_page(
    store: &mut EngineStore,
    workspace_id: &str,
    scope_id: &str,
    mappings: &[WorkReferenceMapping],
    next_after: Option<&str>,
) -> Result<(), DomainError> {
    if next_after.is_some_and(|reference| reference.len() > 2048) {
        return Err(DomainError::InvalidInput {
            reason: "invalid work reference cursor",
        });
    }
    learn_work_references(store, workspace_id, mappings)?;
    store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        tx.execute("INSERT INTO work_reference_sync_pages VALUES (?1,?2,?3) \
            ON CONFLICT(workspace_id,scope_id) DO UPDATE SET after_reference=excluded.after_reference",
            params![workspace_id, scope_id, next_after]).map_err(DomainError::sql_persist)?;
        Ok::<_, DomainError>(())
    })?;
    Ok(())
}

/// Return this device's reference for `input`, making one when there is none.
/// The target check, the reference, and its outbox entry share one
/// transaction.
pub fn make_work_reference(
    store: &mut EngineStore,
    workspace_id: &str,
    input: &WorkTargetInput,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<MadeWorkReference, DomainError> {
    identifier(workspace_id)?;
    match store.write_with(faults, |tx| make_in(tx, workspace_id, input, now_ms))? {
        TxnOutcome::Committed(made) => Ok(made),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("crash fault fired before ack"),
        ))),
    }
}

/// Resolve `reference` to the target it names in `workspace_id`, or
/// `Unknown`.
pub fn resolve_work_reference(
    store: &EngineStore,
    workspace_id: &str,
    reference: &str,
) -> Result<WorkReferenceResolution, DomainError> {
    if !is_work_reference(reference) {
        return Ok(WorkReferenceResolution::Unknown);
    }
    store.read_with(|conn| {
        let _snapshot = conn
            .unchecked_transaction()
            .map_err(DomainError::sql_corrupt)?;
        resolve_in(conn, workspace_id, reference)
    })
}

/// True for a string shaped like a reference. Says nothing about whether it
/// names anything.
pub fn is_work_reference(value: &str) -> bool {
    value.len() == WORK_REFERENCE_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn mint_work_reference() -> Result<String, DomainError> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|_| DomainError::StateCorrupt {
        reason: "the system random source is unavailable",
    })?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

/// A target's row columns. Columns a kind does not use are `None`.
#[derive(Debug, PartialEq, Eq)]
struct Binding {
    kind: &'static str,
    target_id: String,
    version_id: Option<String>,
    dataset_id: Option<String>,
    table_id: Option<String>,
    thread_id: Option<String>,
    channel_id: Option<String>,
}

impl Binding {
    fn of(kind: &'static str, target_id: String) -> Self {
        Binding {
            kind,
            target_id,
            version_id: None,
            dataset_id: None,
            table_id: None,
            thread_id: None,
            channel_id: None,
        }
    }

    fn versioned(kind: &'static str, version_id: String, target_id: String) -> Self {
        Binding {
            version_id: Some(version_id),
            ..Binding::of(kind, target_id)
        }
    }
}

fn make_in(
    tx: &Transaction<'_>,
    workspace_id: &str,
    input: &WorkTargetInput,
    now_ms: i64,
) -> Result<MadeWorkReference, DomainError> {
    let binding = bind(tx, workspace_id, input)?;
    let existing: Option<String> = tx
        .prepare_cached(
            "SELECT reference FROM work_references \
             WHERE workspace_id = ?1 AND target_kind = ?2 AND target_id = ?3 \
               AND ifnull(version_id, '') = ?4 AND ifnull(dataset_id, '') = ?5 \
               AND ifnull(table_id, '') = ?6",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_row(
            params![
                workspace_id,
                binding.kind,
                binding.target_id,
                binding.version_id.as_deref().unwrap_or(""),
                binding.dataset_id.as_deref().unwrap_or(""),
                binding.table_id.as_deref().unwrap_or(""),
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if let Some(reference) = existing {
        return Ok(MadeWorkReference {
            reference,
            created: false,
        });
    }
    let reference = mint_work_reference()?;
    let inserted = tx.execute(
        "INSERT INTO work_references(reference, workspace_id, target_kind, target_id, version_id, \
         dataset_id, table_id, thread_id, channel_id, created_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            reference,
            workspace_id,
            binding.kind,
            binding.target_id,
            binding.version_id,
            binding.dataset_id,
            binding.table_id,
            binding.thread_id,
            binding.channel_id,
            now_ms,
        ],
    );
    inserted.map_err(insert_error)?;
    tx.execute(
        "INSERT INTO work_reference_outbox(reference, enqueued_at_ms) VALUES (?1, ?2)",
        params![reference, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(MadeWorkReference {
        reference,
        created: true,
    })
}

/// A repeated random reference is a duplicate. Any other refusal is a store
/// failure: the target was looked up in this transaction.
fn insert_error(error: rusqlite::Error) -> DomainError {
    match &error {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY =>
        {
            DomainError::DuplicateId
        }
        _ => DomainError::sql_persist(error),
    }
}

/// Check that `input` names work that exists here, and return its stable
/// identity.
fn bind(
    conn: &Connection,
    workspace_id: &str,
    input: &WorkTargetInput,
) -> Result<Binding, DomainError> {
    match input {
        WorkTargetInput::Message { message_id } => {
            identifier(message_id)?;
            let (thread_id, channel_id) = conn
                .prepare_cached(
                    "SELECT m.thread_id, t.channel_id FROM chat_messages m \
                     JOIN chat_threads t ON t.workspace_id = m.workspace_id \
                       AND t.thread_id = m.thread_id \
                     WHERE m.workspace_id = ?1 AND m.message_id = ?2",
                )
                .map_err(DomainError::sql_corrupt)?
                .query_row(params![workspace_id, message_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .optional()
                .map_err(DomainError::sql_corrupt)?
                .ok_or(DomainError::WorkTargetNotFound)?;
            Ok(Binding {
                thread_id: Some(thread_id),
                channel_id,
                ..Binding::of("message", message_id.clone())
            })
        }
        WorkTargetInput::File {
            version_id,
            object_id,
            path,
        }
        | WorkTargetInput::App {
            version_id,
            object_id,
            path,
        } => {
            let kind = if matches!(input, WorkTargetInput::File { .. }) {
                "file"
            } else {
                "app"
            };
            let version_id = version(conn, workspace_id, version_id.as_deref())?;
            let object_id = match (object_id, path) {
                (Some(object_id), None) => {
                    identifier(object_id)?;
                    file_path(conn, workspace_id, &version_id, object_id)?
                        .ok_or(DomainError::WorkTargetNotFound)?;
                    object_id.clone()
                }
                (None, Some(path)) => path_object(conn, workspace_id, &version_id, path)?
                    .ok_or(DomainError::WorkTargetNotFound)?,
                _ => {
                    return Err(DomainError::InvalidInput {
                        reason: "name a file by exactly one of objectId and path",
                    });
                }
            };
            Ok(Binding::versioned(kind, version_id, object_id))
        }
        WorkTargetInput::DocumentRecord {
            version_id,
            record_id,
        } => {
            if !is_record_id(record_id) {
                return Err(DomainError::InvalidInput {
                    reason: "recordId is not a record id",
                });
            }
            let version_id = version(conn, workspace_id, version_id.as_deref())?;
            record_path(conn, workspace_id, &version_id, record_id)?
                .ok_or(DomainError::WorkTargetNotFound)?;
            Ok(Binding::versioned(
                "documentRecord",
                version_id,
                record_id.clone(),
            ))
        }
        WorkTargetInput::DocumentCollection { version_id, path } => {
            let version_id = version(conn, workspace_id, version_id.as_deref())?;
            let path = validate_addressable_plaintext_path(path)?;
            let schema_path: String = conn
                .prepare_cached(
                    "SELECT schema_path FROM collections \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND collection_path = ?3",
                )
                .map_err(DomainError::sql_corrupt)?
                .query_row(params![workspace_id, version_id, path], |row| row.get(0))
                .optional()
                .map_err(DomainError::sql_corrupt)?
                .ok_or(DomainError::WorkTargetNotFound)?;
            let object_id = alias_object(conn, workspace_id, &version_id, &schema_path)?
                .ok_or(DomainError::WorkTargetNotFound)?;
            Ok(Binding::versioned(
                "documentCollection",
                version_id,
                object_id,
            ))
        }
        WorkTargetInput::TransactionalCollection {
            dataset_id,
            table_id,
        } => {
            uuid(dataset_id, "datasetId is not a UUID")?;
            uuid(table_id, "tableId is not a UUID")?;
            Ok(Binding {
                dataset_id: Some(dataset_id.clone()),
                ..Binding::of("transactionalCollection", table_id.clone())
            })
        }
        WorkTargetInput::TransactionalRecord {
            dataset_id,
            table_id,
            record_id,
        } => {
            uuid(dataset_id, "datasetId is not a UUID")?;
            uuid(table_id, "tableId is not a UUID")?;
            Ok(Binding {
                dataset_id: Some(dataset_id.clone()),
                table_id: Some(table_id.clone()),
                ..Binding::of("transactionalRecord", transactional_record_key(record_id)?)
            })
        }
    }
}

type ReferenceRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    bool,
);

fn resolve_in(
    conn: &Connection,
    workspace_id: &str,
    reference: &str,
) -> Result<WorkReferenceResolution, DomainError> {
    let row: Option<ReferenceRow> = conn
        .prepare_cached(
            "SELECT target_kind, target_id, version_id, dataset_id, table_id, thread_id, \
             channel_id, created_at_ms, \
             EXISTS (SELECT 1 FROM work_reference_outbox o WHERE o.reference = r.reference) \
             FROM work_references r WHERE r.reference = ?1 AND r.workspace_id = ?2",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_row(params![reference, workspace_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let row = match row {
        Some(row) => Some(row),
        None => learned_row(conn, workspace_id, reference)?,
    };
    let Some((
        kind,
        target_id,
        version_id,
        dataset_id,
        table_id,
        thread_id,
        channel_id,
        created_at_ms,
        pending,
    )) = row
    else {
        return Ok(WorkReferenceResolution::Unknown);
    };
    let corrupt = || DomainError::StateCorrupt {
        reason: "work reference row does not match its kind",
    };
    // The server registered the reference once its outbox row is gone.
    let registration = if pending {
        WorkReferenceRegistration::Pending
    } else {
        WorkReferenceRegistration::Registered
    };
    // The target, and where it is now: `None` when it is gone.
    let (target, current) = match kind.as_str() {
        "message" => {
            let present = conn
                .prepare_cached(
                    "SELECT 1 FROM chat_messages WHERE workspace_id = ?1 AND message_id = ?2",
                )
                .map_err(DomainError::sql_corrupt)?
                .query_row(params![workspace_id, target_id], |_| Ok(()))
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let target = WorkTarget::Message {
                message_id: target_id,
                thread_id: thread_id.ok_or_else(corrupt)?,
                channel_id,
            };
            (target, present.map(|()| (None, WorkTargetState::Live)))
        }
        "file" | "app" | "documentRecord" | "documentCollection" => {
            let version_id = version_id.ok_or_else(corrupt)?;
            let path = if version_exists(conn, workspace_id, &version_id)? {
                match kind.as_str() {
                    "documentRecord" => record_path(conn, workspace_id, &version_id, &target_id)?,
                    "documentCollection" => {
                        collection_path(conn, workspace_id, &version_id, &target_id)?
                    }
                    _ => file_path(conn, workspace_id, &version_id, &target_id)?,
                }
            } else {
                None
            };
            let target = match kind.as_str() {
                "file" => WorkTarget::File {
                    version_id,
                    object_id: target_id,
                },
                "app" => WorkTarget::App {
                    version_id,
                    object_id: target_id,
                },
                "documentRecord" => WorkTarget::DocumentRecord {
                    version_id,
                    record_id: target_id,
                },
                _ => WorkTarget::DocumentCollection {
                    version_id,
                    object_id: target_id,
                },
            };
            (target, path.map(|path| (Some(path), WorkTargetState::Live)))
        }
        "transactionalCollection" => (
            WorkTarget::TransactionalCollection {
                dataset_id: dataset_id.ok_or_else(corrupt)?,
                table_id: target_id,
            },
            Some((None, WorkTargetState::Unchecked)),
        ),
        "transactionalRecord" => (
            WorkTarget::TransactionalRecord {
                dataset_id: dataset_id.ok_or_else(corrupt)?,
                table_id: table_id.ok_or_else(corrupt)?,
                record_id: serde_json::from_str(&target_id).map_err(|_| corrupt())?,
            },
            Some((None, WorkTargetState::Unchecked)),
        ),
        _ => return Err(corrupt()),
    };
    let (path, state) = current.unwrap_or((None, WorkTargetState::Deleted));
    Ok(WorkReferenceResolution::Found {
        reference: reference.to_owned(),
        target,
        state,
        path,
        created_at_ms,
        registration,
    })
}

fn version(
    conn: &Connection,
    workspace_id: &str,
    version_id: Option<&str>,
) -> Result<String, DomainError> {
    match version_id {
        Some(version_id) => {
            identifier(version_id)?;
            if version_exists(conn, workspace_id, version_id)? {
                Ok(version_id.to_owned())
            } else {
                Err(DomainError::VersionNotFound)
            }
        }
        None => Ok(get_active_version_in(conn, workspace_id)?.version_id),
    }
}

fn version_exists(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, DomainError> {
    conn.prepare_cached("SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2")
        .map_err(DomainError::sql_corrupt)?
        .query_row(params![workspace_id, version_id], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
        .map_err(DomainError::sql_corrupt)
}

fn file_path(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<String>, DomainError> {
    conn.prepare_cached(
        "SELECT path FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
    )
    .map_err(DomainError::sql_corrupt)?
    .query_row(params![workspace_id, version_id, object_id], |row| {
        row.get(0)
    })
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn path_object(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<String>, DomainError> {
    let path = validate_addressable_plaintext_path(path)?;
    alias_object(conn, workspace_id, version_id, &path)
}

fn alias_object(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<String>, DomainError> {
    conn.prepare_cached(
        "SELECT object_id FROM path_aliases \
         WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
    )
    .map_err(DomainError::sql_corrupt)?
    .query_row(params![workspace_id, version_id, path], |row| row.get(0))
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn record_path(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
) -> Result<Option<String>, DomainError> {
    // The record's file decides: a deleted file leaves no snapshot, even
    // before the Collection index catches up.
    conn.prepare_cached(
        "SELECT s.path FROM collection_records r \
         JOIN snapshots s ON s.workspace_id = r.workspace_id \
           AND s.version_id = r.version_id AND s.object_id = r.object_id \
         WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.record_id = ?3",
    )
    .map_err(DomainError::sql_corrupt)?
    .query_row(params![workspace_id, version_id, record_id], |row| {
        row.get(0)
    })
    .optional()
    .map_err(DomainError::sql_corrupt)
}

/// The folder of the Collection whose schema file is `schema_object_id`.
fn collection_path(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    schema_object_id: &str,
) -> Result<Option<String>, DomainError> {
    conn.prepare_cached(
        "SELECT c.collection_path FROM collections c \
         JOIN path_aliases a ON a.workspace_id = c.workspace_id \
           AND a.version_id = c.version_id AND a.path = c.schema_path \
         WHERE c.workspace_id = ?1 AND c.version_id = ?2 AND a.object_id = ?3",
    )
    .map_err(DomainError::sql_corrupt)?
    .query_row(params![workspace_id, version_id, schema_object_id], |row| {
        row.get(0)
    })
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn identifier(value: &str) -> Result<(), DomainError> {
    if value.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "an identifier is empty",
        });
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(DomainError::IdentifierTooLong {
            field: "work_target",
            limit_bytes: MAX_IDENTIFIER_BYTES,
            observed_bytes: value.len(),
        });
    }
    Ok(())
}

/// A lowercase canonical UUID, as the dataset contracts write them.
fn uuid(value: &str, reason: &'static str) -> Result<(), DomainError> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        });
    if shaped {
        Ok(())
    } else {
        Err(DomainError::InvalidInput { reason })
    }
}

/// A transactional record id as stored: its JSON text, so a number and a
/// string stay different.
fn transactional_record_key(record_id: &TransactionalRecordId) -> Result<String, DomainError> {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    let valid = match record_id {
        TransactionalRecordId::Number(number) => number.unsigned_abs() <= MAX_SAFE_INTEGER,
        TransactionalRecordId::Text(text) => !text.is_empty(),
    };
    let invalid = || DomainError::InvalidInput {
        reason: "recordId is not a transactional record id",
    };
    if !valid {
        return Err(invalid());
    }
    serde_json::to_string(record_id).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_repeated_reference_is_a_duplicate() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&root.path().join("engine.db"), 1).unwrap();
        let outcome = store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                let insert = |reference: String, kind: &str, target: &str| {
                    tx.execute(
                        "INSERT INTO work_references(reference, workspace_id, target_kind, \
                         target_id, dataset_id, created_at_ms) VALUES (?1, 'ws', ?2, ?3, 'd', 1)",
                        params![reference, kind, target],
                    )
                    .map(|_| ())
                    .map_err(insert_error)
                };
                insert("A".repeat(43), "transactionalCollection", "t")?;
                Ok::<_, DomainError>([
                    insert("A".repeat(43), "transactionalCollection", "other"),
                    insert("B".repeat(43), "transactionalCollection", "t"),
                    insert("C".repeat(43), "message", "m"),
                ])
            })
            .unwrap();
        let TxnOutcome::Committed([repeated, same_target, wrong_kind]) = outcome else {
            panic!("the inserts crashed");
        };
        assert!(
            matches!(repeated, Err(DomainError::DuplicateId)),
            "{repeated:?}"
        );
        assert!(
            matches!(same_target, Err(DomainError::Storage(_))),
            "{same_target:?}"
        );
        assert!(
            matches!(wrong_kind, Err(DomainError::Storage(_))),
            "{wrong_kind:?}"
        );
    }

    #[test]
    fn a_minted_reference_is_256_url_safe_bits() {
        let reference = mint_work_reference().unwrap();
        assert!(is_work_reference(&reference), "{reference}");
        assert_eq!(URL_SAFE_NO_PAD.decode(&reference).unwrap().len(), 32);
        assert_ne!(reference, mint_work_reference().unwrap());
    }

    #[test]
    fn reference_shape_rejects_padding_and_other_alphabets() {
        assert!(!is_work_reference(&"a".repeat(42)));
        assert!(!is_work_reference(&"a".repeat(44)));
        assert!(!is_work_reference(&format!("{}=", "a".repeat(42))));
        assert!(!is_work_reference(&format!("{}+", "a".repeat(42))));
        assert!(is_work_reference(&format!("{}-_", "a".repeat(41))));
    }

    #[test]
    fn transactional_record_ids_keep_their_json_type() {
        assert_eq!(
            transactional_record_key(&TransactionalRecordId::Number(7)).unwrap(),
            "7"
        );
        assert_eq!(
            transactional_record_key(&TransactionalRecordId::Text("7".into())).unwrap(),
            "\"7\""
        );
        assert!(transactional_record_key(&TransactionalRecordId::Number(1 << 53)).is_err());
        assert!(transactional_record_key(&TransactionalRecordId::Text(String::new())).is_err());
    }

    #[test]
    fn work_reference_reads_use_indexes() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store = EngineStore::open(&root.path().join("engine.db"), 1).unwrap();
        store
            .read_with(|conn| -> rusqlite::Result<()> {
                for query in [
                    "SELECT reference FROM work_references \
                     WHERE workspace_id = 'ws' AND target_kind = 'file' AND target_id = 'o' \
                       AND ifnull(version_id, '') = 'main' AND ifnull(dataset_id, '') = '' \
                       AND ifnull(table_id, '') = ''",
                    "SELECT target_kind, \
                     EXISTS (SELECT 1 FROM work_reference_outbox o WHERE o.reference = r.reference) \
                     FROM work_references r WHERE r.reference = 'r' AND r.workspace_id = 'ws'",
                ] {
                    let plan = conn
                        .prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
                        .query_map([], |row| row.get::<_, String>(3))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    assert!(
                        plan.iter()
                            .any(|step| step.contains("SEARCH") && step.contains("INDEX")),
                        "{plan:?}"
                    );
                    assert!(!plan.iter().any(|step| step.contains("SCAN")), "{plan:?}");
                }
                Ok(())
            })
            .unwrap();
    }
}
