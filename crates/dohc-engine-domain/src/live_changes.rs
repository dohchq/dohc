//! Who stopped or resumed live editing of each owner document.
//!
//! The desktop begins a change before it acts and finishes it with its own
//! operation's response. A begun change is pending; an applied one replaces
//! the document's last change, and a refused one leaves the last change as it
//! was. A pending change that an interrupted action left behind is listed until
//! the desktop finishes it. Each change names its pending record, so a late
//! finish of an older change never settles a newer one.
//!
//! The relay keeps no author, so no relay status can credit a change: one
//! interrupted after the relay applied it is refused, and the document shows
//! no author rather than another actor's.
//!
//! The records are local provenance only. They grant nothing and outlive their
//! document: nothing else deletes them. Live editing itself is the relay's and
//! `owner_live_stops`'s business.

use crate::DomainError;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_storage::{EngineStore, MAX_IDENTIFIER_BYTES, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The most documents one list names.
pub const MAX_LISTED_DOCUMENTS: usize = 200;

/// The person or agent that asked for a change, as the desktop knows them.
/// It is the same shape as a workspace sync pause's author.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ChangeAuthor {
    #[serde(rename_all = "camelCase")]
    Person { person_id: String },
    #[serde(rename_all = "camelCase")]
    Agent {
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_name: Option<String>,
        on_behalf_of: String,
        depth: u64,
    },
}

impl ChangeAuthor {
    fn validate(&self) -> Result<(), DomainError> {
        match self {
            Self::Person { person_id } => identifier(person_id),
            Self::Agent {
                agent_id,
                agent_name,
                on_behalf_of,
                depth,
            } => {
                identifier(agent_id)?;
                identifier(on_behalf_of)?;
                // The desktop reads the depth back as a safe integer.
                if *depth > 9_007_199_254_740_991 {
                    return Err(invalid("an agent depth is too large"));
                }
                // The desktop's limit counts UTF-16 units.
                if agent_name
                    .as_ref()
                    .is_some_and(|name| name.is_empty() || name.encode_utf16().count() > 64)
                {
                    return Err(invalid("an agent name is empty or longer than 64"));
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveChangeAction {
    Stopped,
    Resumed,
}

impl LiveChangeAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Resumed => "resumed",
        }
    }

    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "stopped" => Ok(Self::Stopped),
            "resumed" => Ok(Self::Resumed),
            _ => Err(corrupt()),
        }
    }

    /// The relay already shows what this action would produce.
    fn already(self, before: LiveStatus) -> bool {
        match self {
            Self::Stopped => before == LiveStatus::Retired,
            Self::Resumed => matches!(before, LiveStatus::Ready | LiveStatus::Preparing),
        }
    }
}

/// The relay's status of the document when the desktop began the change.
/// `absent` means the relay listed no such document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStatus {
    Ready,
    Preparing,
    Paused,
    Retired,
    Unavailable,
    Absent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveChangeOutcome {
    Applied,
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginLiveChange {
    pub object_id: String,
    pub path: String,
    pub action: LiveChangeAction,
    pub author: ChangeAuthor,
    pub before: LiveStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BegunLiveChange {
    pub change_id: String,
    pub at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLiveChange {
    pub change_id: String,
    pub action: LiveChangeAction,
    pub path: String,
    pub at_ms: i64,
    pub author: ChangeAuthor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastLiveChange {
    pub action: LiveChangeAction,
    pub path: String,
    pub at_ms: i64,
    pub author: ChangeAuthor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDocumentChanges {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingLiveChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<LastLiveChange>,
}

/// Records a pending change. Returns `None`, recording nothing, when `before`
/// already shows what the action would produce, or while the document has a
/// pending change: an action that changes nothing must not take credit for the
/// state another change made, and replacing a change already under way would
/// lose its record if the relay applies it.
pub fn begin_live_change(
    store: &mut EngineStore,
    workspace_id: &str,
    input: &BeginLiveChange,
    now_ms: i64,
) -> Result<Option<BegunLiveChange>, DomainError> {
    identifier(workspace_id)?;
    identifier(&input.object_id)?;
    let path = crate::validate_plaintext_storable_path(&input.path)?;
    input.author.validate()?;
    if input.action.already(input.before) {
        return Ok(None);
    }
    let change_id = random_change_id()?;
    let author = serde_json::to_string(&input.author).map_err(|_| corrupt())?;
    let inserted = committed(store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        tx.execute(
            "INSERT INTO live_document_changes(workspace_id,slot,object_id,change_id,action,path,at_ms,author_json) \
             VALUES(?1,'pending',?2,?3,?4,?5,?6,?7) ON CONFLICT(workspace_id,slot,object_id) DO NOTHING",
            params![
                workspace_id,
                input.object_id,
                change_id,
                input.action.as_str(),
                path,
                now_ms,
                author
            ],
        )
        .map_err(DomainError::sql_persist)
    })?)?;
    Ok((inserted == 1).then_some(BegunLiveChange {
        change_id,
        at_ms: now_ms,
    }))
}

/// Settles the pending change `change_id` names. Applied, it becomes the
/// document's last change; refused, it is dropped and the last change stays.
/// Returns false when the document has no such pending change, as for a
/// change already settled.
pub fn finish_live_change(
    store: &mut EngineStore,
    workspace_id: &str,
    object_id: &str,
    change_id: &str,
    outcome: LiveChangeOutcome,
) -> Result<bool, DomainError> {
    identifier(workspace_id)?;
    identifier(object_id)?;
    identifier(change_id)?;
    committed(store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        finish_in(tx, workspace_id, object_id, change_id, outcome)
    })?)
}

fn finish_in(
    tx: &Transaction<'_>,
    workspace_id: &str,
    object_id: &str,
    change_id: &str,
    outcome: LiveChangeOutcome,
) -> Result<bool, DomainError> {
    let found = tx
        .query_row(
            "SELECT 1 FROM live_document_changes WHERE workspace_id=?1 AND slot='pending' AND object_id=?2 AND change_id=?3",
            params![workspace_id, object_id, change_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if found.is_none() {
        return Ok(false);
    }
    if outcome == LiveChangeOutcome::Applied {
        tx.execute(
            "INSERT INTO live_document_changes(workspace_id,slot,object_id,change_id,action,path,at_ms,author_json) \
             SELECT workspace_id,'last',object_id,NULL,action,path,at_ms,author_json FROM live_document_changes \
             WHERE workspace_id=?1 AND slot='pending' AND object_id=?2 \
             ON CONFLICT(workspace_id,slot,object_id) DO UPDATE SET action=excluded.action,path=excluded.path,\
             at_ms=excluded.at_ms,author_json=excluded.author_json",
            params![workspace_id, object_id],
        )
        .map_err(DomainError::sql_persist)?;
    }
    tx.execute(
        "DELETE FROM live_document_changes WHERE workspace_id=?1 AND slot='pending' AND object_id=?2",
        params![workspace_id, object_id],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(true)
}

/// The changes of `object_ids`, and every document with a pending change, in
/// object order. A document with neither is left out.
pub fn list_live_changes(
    store: &EngineStore,
    workspace_id: &str,
    object_ids: &[String],
) -> Result<Vec<LiveDocumentChanges>, DomainError> {
    identifier(workspace_id)?;
    if object_ids.len() > MAX_LISTED_DOCUMENTS {
        return Err(invalid("too many documents"));
    }
    for object_id in object_ids {
        identifier(object_id)?;
    }
    store.read_with(|conn| {
        let _snapshot = conn
            .unchecked_transaction()
            .map_err(DomainError::sql_corrupt)?;
        list_in(conn, workspace_id, object_ids)
    })
}

fn list_in(
    conn: &Connection,
    workspace_id: &str,
    object_ids: &[String],
) -> Result<Vec<LiveDocumentChanges>, DomainError> {
    let mut documents = BTreeMap::<String, LiveDocumentChanges>::new();
    let mut pending = conn
        .prepare(
            "SELECT object_id,change_id,action,path,at_ms,author_json FROM live_document_changes \
             WHERE workspace_id=?1 AND slot='pending'",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = pending
        .query_map([workspace_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        let (object_id, change_id, action, path, at_ms, author) =
            row.map_err(DomainError::sql_corrupt)?;
        entry(&mut documents, &object_id).pending = Some(PendingLiveChange {
            change_id,
            action: LiveChangeAction::parse(&action)?,
            path,
            at_ms,
            author: author_from(&author)?,
        });
    }
    let mut last = conn
        .prepare(
            "SELECT action,path,at_ms,author_json FROM live_document_changes \
             WHERE workspace_id=?1 AND slot='last' AND object_id=?2",
        )
        .map_err(DomainError::sql_corrupt)?;
    for object_id in object_ids {
        let row = last
            .query_row(params![workspace_id, object_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        let Some((action, path, at_ms, author)) = row else {
            continue;
        };
        entry(&mut documents, object_id).last = Some(LastLiveChange {
            action: LiveChangeAction::parse(&action)?,
            path,
            at_ms,
            author: author_from(&author)?,
        });
    }
    Ok(documents.into_values().collect())
}

fn entry<'a>(
    documents: &'a mut BTreeMap<String, LiveDocumentChanges>,
    object_id: &str,
) -> &'a mut LiveDocumentChanges {
    documents
        .entry(object_id.to_owned())
        .or_insert_with(|| LiveDocumentChanges {
            object_id: object_id.to_owned(),
            pending: None,
            last: None,
        })
}

fn author_from(json: &str) -> Result<ChangeAuthor, DomainError> {
    serde_json::from_str(json).map_err(|_| corrupt())
}

fn random_change_id() -> Result<String, DomainError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| DomainError::StateCorrupt {
        reason: "the system random source is unavailable",
    })?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(
            dohc_engine_storage::StorageError::persist_public(std::io::Error::other(
                "crash fault fired before ack",
            )),
        )),
    }
}

fn identifier(value: &str) -> Result<(), DomainError> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid("an identifier is empty or holds a NUL"));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(DomainError::IdentifierTooLong {
            field: "live_document_change",
            limit_bytes: MAX_IDENTIFIER_BYTES,
            observed_bytes: value.len(),
        });
    }
    Ok(())
}

fn invalid(reason: &'static str) -> DomainError {
    DomainError::InvalidInput { reason }
}

fn corrupt() -> DomainError {
    DomainError::StateCorrupt {
        reason: "a live document change record is unreadable",
    }
}
