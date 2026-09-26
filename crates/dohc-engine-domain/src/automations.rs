//! Automation trigger claims (ADR 0008): local state in engine.db, never
//! replicated, shaped like the chat dispatch ledger. The origin device — and
//! only the origin device — turns a committed local record change into one
//! durable `automation_claims` row per subscribed automation, inside the same
//! transaction that committed the change. The desktop drains claims through
//! the pending -> running -> done | failed machine and the startup reaper
//! requeues or terminally fails claims a dead process left running.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::chats::{base32_lowercase_no_padding, is_js_trim_ws};
use crate::collections::{
    ChangeActorKind, CollectionFieldChangeFact, CollectionRecordApplyFacts,
    CollectionRecordLifecycle, CollectionRecordLifecycleKind, field_fact_value,
    indexed_record_fields, moment_author_attribution, parent_path,
};
use crate::error::DomainError;
use dohc_engine_storage::{
    EngineStore, FaultInjector, MAX_IDENTIFIER_BYTES, StorageError, TxnOutcome,
};

/// The product chain limit from the settled Phase 4 block: an automation's
/// writes carry depth one greater than their trigger, and a change already at
/// this depth triggers nothing. Distinct from the wire bound
/// (`MAX_CHANGE_ATTRIBUTION_DEPTH`), which only keeps declared values sane.
pub const AUTOMATION_CHAIN_DEPTH_CAP: u32 = 4;

/// The terminal error the startup reaper records when a crashed claim has no
/// attempts left — the same reason string the chat dispatch ledger uses.
pub const AUTOMATION_RECLAIM_EXHAUSTED: &str = "reclaim-exhausted";

/// The error a claim records when a change at the chain depth cap would have
/// triggered an automation: the chain stops, and the stop is reported to the
/// owner through the same failed-claim path every other terminal failure
/// takes (the settled block's "a chain stops at depth 4 and the stop is
/// reported").
pub const AUTOMATION_CHAIN_STOPPED: &str = "chain-stopped";

/// Bound on the error text a failed settle records.
pub const MAX_AUTOMATION_ERROR_BYTES: usize = 4096;

/// The namespace every automation id lives in: Collection automations are
/// `collection:<collection path>#<automation id>`. The Collection executor
/// drains this namespace, so a subscription outside it would claim work
/// nothing ever runs.
pub const AUTOMATION_ID_NAMESPACE: &str = "collection:";

/// The most field names one subscription may list. An automation that
/// watches more fields subscribes to every field.
pub const MAX_AUTOMATION_SUBSCRIPTION_FIELDS: usize = 64;

/// All of one claim's field facts together stay under this many bytes of
/// JSON, so a served claim always fits one response. Past the budget a value
/// travels truncated, and a field that does not fit even with truncated
/// values is counted in [`AutomationFieldFacts::omitted`].
pub const MAX_AUTOMATION_FIELD_FACTS_BYTES: usize = 64 * 1024;

/// How many of an automation's newest claims `automations.listClaims`
/// returns. A settle prunes the automation's done claims older than these.
/// A claim that ever failed stays: it is the evidence ADR 0008 keeps, and
/// the failure generation counts it.
pub const AUTOMATION_CLAIM_HISTORY_LIMIT: i64 = 100;

/// A kind of record change. A subscription names the kinds it wants; a
/// claim names the kind it runs for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationChangeKind {
    /// A moment on this computer created the record's file in its
    /// Collection or moved it in.
    Added,
    /// A change on this computer wrote one or more of the record's fields.
    Changed,
    /// A moment on this computer deleted the record's file or moved it out
    /// of its Collection.
    Removed,
    /// This computer stored a new message in a watched Group. Only a Group
    /// subscription claims it; a record subscription cannot name it.
    Message,
    /// A person on this computer pressed a Button field on a record.
    Button,
    /// A schedule came due on the computer that runs the workspace's
    /// schedules.
    Schedule,
}

impl AutomationChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AutomationChangeKind::Added => "added",
            AutomationChangeKind::Changed => "changed",
            AutomationChangeKind::Removed => "removed",
            AutomationChangeKind::Message => "message",
            AutomationChangeKind::Button => "button",
            AutomationChangeKind::Schedule => "schedule",
        }
    }

    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "added" => Ok(AutomationChangeKind::Added),
            "changed" => Ok(AutomationChangeKind::Changed),
            "removed" => Ok(AutomationChangeKind::Removed),
            "message" => Ok(AutomationChangeKind::Message),
            "button" => Ok(AutomationChangeKind::Button),
            "schedule" => Ok(AutomationChangeKind::Schedule),
            _ => Err(DomainError::StateCorrupt {
                reason: "automation change kind is not a known kind",
            }),
        }
    }

    /// The `automation_subscriptions` column that says whether a record
    /// subscription wants this kind. Messages have Group subscriptions, and
    /// presses and schedules claim without one.
    fn subscription_column(self) -> Option<&'static str> {
        match self {
            AutomationChangeKind::Added => Some("on_added"),
            AutomationChangeKind::Changed => Some("on_changed"),
            AutomationChangeKind::Removed => Some("on_removed"),
            AutomationChangeKind::Message
            | AutomationChangeKind::Button
            | AutomationChangeKind::Schedule => None,
        }
    }
}

/// One automation's interest in the record changes under a collection path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationSubscription {
    pub automation_id: String,
    /// A collection path prefix; `"."` is the whole workspace.
    pub prefix: String,
    /// The change kinds that claim. Never empty.
    pub kinds: Vec<AutomationChangeKind>,
    /// A changed record claims only when one of these fields changed;
    /// `None` claims on any field. Added and removed records ignore it.
    pub fields: Option<Vec<String>>,
}

/// One Collection automation's interest in the messages of one Group: every
/// new message, or only one whose text starts with `starts_with` after its
/// leading whitespace, compared exactly. Only the computer that runs Group
/// automations registers these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupSubscription {
    /// `collection:<collection path>#<automation id>`.
    pub automation_id: String,
    /// The Group's channel id on this computer.
    pub channel_id: String,
    pub starts_with: Option<String>,
}

/// A message this computer is storing, as a Group automation's claim sees it.
#[derive(Debug, Clone, Copy)]
pub struct AutomationGroupMessage<'a> {
    pub message_id: &'a str,
    pub thread_id: &'a str,
    pub parent_message_id: Option<&'a str>,
    /// The stored author kind: `human`, `agent`, or `automation`.
    pub author_kind: &'a str,
    pub author_display_name: &'a str,
    pub author_owner_display_name: Option<&'a str>,
    pub author_user_id: Option<&'a str>,
    pub body: &'a str,
    pub created_at_ms: i64,
    /// The automation on this computer that wrote it. A message from another
    /// computer has none.
    pub automation_id: Option<&'a str>,
    /// An automation message's chain depth: this computer's, or the one
    /// another computer sent with the message.
    pub chain_depth: Option<u32>,
}

/// The change a claim runs for and who made it, named as record history
/// names them: the author origin, and the declared actor kind and the
/// principal it acted for. Each is `None` when the write did not declare it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationChange {
    pub kind: AutomationChangeKind,
    pub author_origin_id: Option<String>,
    pub actor_kind: Option<ChangeActorKind>,
    pub on_behalf_of: Option<String>,
}

/// One side of a changed field on a claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AutomationFactValue {
    Whole {
        value: Value,
    },
    /// The value is larger or deeper than a claim carries, or the claim's
    /// budget was spent. `bytes` is its size as stored JSON; the whole value
    /// is in the field history row the fact names, or, for an added or
    /// removed record, in the record or its last moment.
    Truncated {
        truncated: bool,
        bytes: usize,
    },
}

/// One field on a claim, with its value before and after the change,
/// `None` where the field was absent. A changed field names the history row
/// that recorded it. An added record lists its fields as `next` values and a
/// removed record its last known values as `previous`; neither has a
/// history row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationFieldFact {
    #[serde(rename = "field")]
    pub field_name: String,
    pub history_id: Option<i64>,
    pub previous: Option<AutomationFactValue>,
    pub next: Option<AutomationFactValue>,
}

/// A claim's field facts, in field-name order, within
/// [`MAX_AUTOMATION_FIELD_FACTS_BYTES`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutomationFieldFacts {
    pub fields: Vec<AutomationFieldFact>,
    /// Changed fields left out because even their truncated facts did not
    /// fit. The executor reads the record's history for them.
    pub omitted: u32,
    /// A message claim's message, within the same budget: its body travels
    /// whole, or as `{ "truncated": true, "bytes": N }` for the executor to
    /// read through `chats.messages.get`. A record claim has none.
    pub message: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationClaimState {
    Pending,
    Running,
    Done,
    Failed,
}

impl AutomationClaimState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AutomationClaimState::Pending => "pending",
            AutomationClaimState::Running => "running",
            AutomationClaimState::Done => "done",
            AutomationClaimState::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "pending" => Ok(AutomationClaimState::Pending),
            "running" => Ok(AutomationClaimState::Running),
            "done" => Ok(AutomationClaimState::Done),
            "failed" => Ok(AutomationClaimState::Failed),
            _ => Err(DomainError::StateCorrupt {
                reason: "automation claim state is not a known state",
            }),
        }
    }
}

/// The durable per-change key a claim holds. A synced-lineage field change
/// keys on its replication coordinate — the one identifier every peer
/// derives identically — and a field change no other device can see keys on
/// this device's history row id (the settled Phase 4 fallback). An added or
/// removed record keys on the moment that moved its file into or out of
/// the Collection, together with the change kind, so however often
/// reconcile derives the same change it claims it once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationTrigger {
    Coordinate {
        origin_id: String,
        origin_seq: i64,
    },
    History {
        history_id: i64,
    },
    Moment {
        moment_order: i64,
    },
    /// A trigger that is not a record change names its own key. A Group
    /// message is `message:<message id>`, the same however the message
    /// reaches this computer, so it claims once.
    Key {
        key: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationClaim {
    pub claim_id: String,
    pub automation_id: String,
    pub trigger: AutomationTrigger,
    /// The changed record. A message claim has none.
    pub record_id: Option<String>,
    pub collection_path: String,
    /// The triggering change's chain depth (0 for an unattributed or
    /// human-authored trigger). The handler's own writes declare depth + 1.
    pub depth: u32,
    pub change: AutomationChange,
    pub state: AutomationClaimState,
    /// How many times `claimNext` served the claim, across every run. The
    /// reaper's attempt bound counts these, so a retried claim that crashes
    /// fails with [`AUTOMATION_RECLAIM_EXHAUSTED`] instead of being requeued.
    pub attempts: i64,
    /// Which run of the claim this is: 1, plus one per `automations.retry`.
    /// A crash requeue keeps the run. Executors key their writes on
    /// `<claim id>/<run>/<write ordinal>`, so a requeued run repeats its
    /// writes under the same keys and a retried run writes under new ones.
    pub run: i64,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl AutomationClaim {
    /// A claim the chain depth cap stopped: inserted failed and never served.
    pub fn chain_stopped(&self) -> bool {
        self.state == AutomationClaimState::Failed && self.attempts == 0
    }
}

/// One running attempt observed before a workspace handle is published.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AutomationClaimAttempt {
    pub claim_id: String,
    pub attempts: i64,
    pub started_at_ms: i64,
}

pub fn list_running_automation_attempts(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<AutomationClaimAttempt>, DomainError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT claim_id, attempts, updated_at_ms FROM automation_claims \
                 WHERE workspace_id = ?1 AND state = 'running' ORDER BY claim_id",
            )
            .map_err(DomainError::sql_corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                Ok(AutomationClaimAttempt {
                    claim_id: row.get(0)?,
                    attempts: row.get(1)?,
                    started_at_ms: row.get(2)?,
                })
            })
            .map_err(DomainError::sql_corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DomainError::sql_corrupt)
    })
}

/// How `automations.settle` closes a running claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationSettle {
    Done,
    Failed { error: String },
}

fn normalize_automation_identifier(
    value: &str,
    reason: &'static str,
) -> Result<String, DomainError> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.len() > MAX_IDENTIFIER_BYTES || normalized.contains('\0')
    {
        Err(DomainError::InvalidInput { reason })
    } else {
        Ok(normalized.to_owned())
    }
}

/// Prefix containment, mirroring the desktop watch registry: `"."` is the
/// whole workspace; otherwise the collection path must equal the prefix or
/// live under it.
fn prefix_contains(prefix: &str, collection_path: &str) -> bool {
    prefix == "."
        || collection_path == prefix
        || collection_path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn mint_claim_id() -> Result<String, DomainError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| DomainError::StateCorrupt {
        reason: "automation claim id entropy unavailable",
    })?;
    Ok(format!("atc_{}", base32_lowercase_no_padding(&random)))
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("crash fault fired before ack"),
        ))),
    }
}

const CLAIM_COLUMNS: &str = "claim_id, automation_id, trigger_origin_id, trigger_origin_seq, \
     trigger_history_id, record_id, collection_path, depth, state, attempts, error, \
     created_at_ms, updated_at_ms, change_kind, author_origin_id, actor_kind, on_behalf_of, run, \
     trigger_moment_order, trigger_key";

fn claim_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<AutomationClaim, DomainError>> {
    let claim_id: String = row.get(0)?;
    let automation_id: String = row.get(1)?;
    let trigger_origin_id: Option<String> = row.get(2)?;
    let trigger_origin_seq: Option<i64> = row.get(3)?;
    let trigger_history_id: Option<i64> = row.get(4)?;
    let record_id: Option<String> = row.get(5)?;
    let collection_path: String = row.get(6)?;
    let depth: i64 = row.get(7)?;
    let state: String = row.get(8)?;
    let attempts: i64 = row.get(9)?;
    let error: Option<String> = row.get(10)?;
    let created_at_ms: i64 = row.get(11)?;
    let updated_at_ms: i64 = row.get(12)?;
    let change_kind: String = row.get(13)?;
    let author_origin_id: Option<String> = row.get(14)?;
    let actor_kind: Option<String> = row.get(15)?;
    let on_behalf_of: Option<String> = row.get(16)?;
    let run: i64 = row.get(17)?;
    let trigger_moment_order: Option<i64> = row.get(18)?;
    let trigger_key: Option<String> = row.get(19)?;
    let claim = (|| {
        let actor_kind = actor_kind
            .map(|kind| {
                ChangeActorKind::parse(&kind).ok_or(DomainError::StateCorrupt {
                    reason: "automation claim actor kind is not a known kind",
                })
            })
            .transpose()?;
        let trigger = match (
            trigger_origin_id,
            trigger_origin_seq,
            trigger_history_id,
            trigger_moment_order,
            trigger_key,
        ) {
            (Some(origin_id), Some(origin_seq), None, None, None) => {
                AutomationTrigger::Coordinate {
                    origin_id,
                    origin_seq,
                }
            }
            (None, None, Some(history_id), None, None) => AutomationTrigger::History { history_id },
            (None, None, None, Some(moment_order), None) => {
                AutomationTrigger::Moment { moment_order }
            }
            (None, None, None, None, Some(key)) => AutomationTrigger::Key { key },
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "automation claim trigger key is not exactly one shape",
                });
            }
        };
        Ok(AutomationClaim {
            claim_id,
            automation_id,
            trigger,
            record_id,
            collection_path,
            depth: u32::try_from(depth).map_err(|_| DomainError::StateCorrupt {
                reason: "automation claim depth is negative",
            })?,
            change: AutomationChange {
                kind: AutomationChangeKind::parse(&change_kind)?,
                author_origin_id,
                actor_kind,
                on_behalf_of,
            },
            state: AutomationClaimState::parse(&state)?,
            attempts,
            run,
            error,
            created_at_ms,
            updated_at_ms,
        })
    })();
    Ok(claim)
}

fn claim_by_id(
    conn: &Connection,
    workspace_id: &str,
    claim_id: &str,
) -> Result<Option<AutomationClaim>, DomainError> {
    conn.query_row(
        &format!(
            "SELECT {CLAIM_COLUMNS} FROM automation_claims \
             WHERE workspace_id = ?1 AND claim_id = ?2"
        ),
        params![workspace_id, claim_id],
        claim_from_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()
}

/// The field names a subscription stores: sorted, deduplicated, and each an
/// exact frontmatter key, so nothing is trimmed.
fn subscription_field_names_json(fields: Option<&[String]>) -> Result<Option<String>, DomainError> {
    let Some(fields) = fields else {
        return Ok(None);
    };
    if fields.is_empty() || fields.len() > MAX_AUTOMATION_SUBSCRIPTION_FIELDS {
        return Err(DomainError::InvalidInput {
            reason: "Automation subscription fields must be a non-empty, bounded list.",
        });
    }
    if fields
        .iter()
        .any(|field| field.is_empty() || field.len() > MAX_IDENTIFIER_BYTES || field.contains('\0'))
    {
        return Err(DomainError::InvalidInput {
            reason: "Automation subscription field name is invalid.",
        });
    }
    let mut fields = fields.to_vec();
    fields.sort_unstable();
    fields.dedup();
    serde_json::to_string(&fields)
        .map(Some)
        .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))
}

/// Register one `(automation, collection-path prefix)` interest with the
/// change kinds and fields it wants. A second call for the same pair
/// replaces its filter. Returns whether the stored subscription changed.
pub fn subscribe_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    subscription: &AutomationSubscription,
    now_ms: i64,
) -> Result<bool, DomainError> {
    let automation_id =
        normalize_automation_identifier(&subscription.automation_id, "Automation id is invalid.")?;
    if automation_id.len() <= AUTOMATION_ID_NAMESPACE.len()
        || !automation_id.starts_with(AUTOMATION_ID_NAMESPACE)
    {
        return Err(DomainError::InvalidInput {
            reason: "Automation id must start with collection:.",
        });
    }
    let prefix = normalize_automation_identifier(
        &subscription.prefix,
        "Automation subscription path is invalid.",
    )?;
    if subscription.kinds.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "Automation subscription must name at least one change kind.",
        });
    }
    if subscription.kinds.contains(&AutomationChangeKind::Message) {
        return Err(DomainError::InvalidInput {
            reason: "A record subscription cannot name messages. Subscribe to a Group.",
        });
    }
    if subscription
        .kinds
        .iter()
        .any(|kind| kind.subscription_column().is_none())
    {
        return Err(DomainError::InvalidInput {
            reason: "A record subscription cannot name buttons or schedules. They claim when pressed or due.",
        });
    }
    let wants = |kind| subscription.kinds.contains(&kind);
    let field_names_json = subscription_field_names_json(subscription.fields.as_deref())?;
    let changed = conn
        .execute(
            "INSERT INTO automation_subscriptions \
             (workspace_id, automation_id, prefix, on_added, on_changed, on_removed, \
              field_names_json, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(workspace_id, automation_id, prefix) DO UPDATE SET \
               on_added = excluded.on_added, on_changed = excluded.on_changed, \
               on_removed = excluded.on_removed, field_names_json = excluded.field_names_json \
             WHERE on_added IS NOT excluded.on_added OR on_changed IS NOT excluded.on_changed \
               OR on_removed IS NOT excluded.on_removed \
               OR field_names_json IS NOT excluded.field_names_json",
            params![
                workspace_id,
                automation_id,
                prefix,
                wants(AutomationChangeKind::Added),
                wants(AutomationChangeKind::Changed),
                wants(AutomationChangeKind::Removed),
                field_names_json,
                now_ms,
            ],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(changed == 1)
}

/// The Collection path of a Collection automation id,
/// `collection:<path>#<automation id>`. The path must name a folder inside
/// the workspace, because the renderer opens files under it. The rule is the
/// bridge's `isSafeRelativePath`: relative, with no drive letter, no empty,
/// `.`, or `..` segment, and no backslash. A colon elsewhere is a folder
/// name.
pub fn collection_automation_path(automation_id: &str) -> Option<&str> {
    let (path, local) = automation_id
        .strip_prefix("collection:")?
        .rsplit_once('#')?;
    let canonical = !local.is_empty()
        && !path.contains('\\')
        && !matches!(path.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
        && path
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."));
    (canonical
        && automation_id.len() <= MAX_IDENTIFIER_BYTES
        && automation_id.trim() == automation_id
        && !automation_id.chars().any(char::is_control))
    .then_some(path)
}

/// Register one Collection automation's interest in one Group's messages. A
/// second call for the pair replaces its prefix. Returns whether the stored
/// subscription changed.
pub fn subscribe_automation_group_in_tx(
    conn: &Connection,
    workspace_id: &str,
    subscription: &AutomationGroupSubscription,
    now_ms: i64,
) -> Result<bool, DomainError> {
    if collection_automation_path(&subscription.automation_id).is_none() {
        return Err(DomainError::InvalidInput {
            reason: "A Group subscription belongs to a Collection automation, collection:<path>#<id>.",
        });
    }
    let channel_id =
        normalize_automation_identifier(&subscription.channel_id, "Group id is invalid.")?;
    let is_group: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_channels \
             WHERE workspace_id = ?1 AND channel_id = ?2 AND kind = 'channel')",
            params![workspace_id, channel_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    if !is_group {
        return Err(DomainError::InvalidInput {
            reason: "A Group subscription names a Group on this computer.",
        });
    }
    if let Some(prefix) = &subscription.starts_with
        && (prefix.is_empty()
            || prefix.len() > MAX_IDENTIFIER_BYTES
            || prefix.starts_with(is_js_trim_ws)
            || prefix.contains('\0'))
    {
        return Err(DomainError::InvalidInput {
            reason: "A Group subscription's starting text must be bounded and start with text, not space.",
        });
    }
    let changed = conn
        .execute(
            "INSERT INTO automation_group_subscriptions \
             (workspace_id, automation_id, channel_id, starts_with, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(workspace_id, automation_id, channel_id) DO UPDATE SET \
               starts_with = excluded.starts_with \
             WHERE starts_with IS NOT excluded.starts_with",
            params![
                workspace_id,
                subscription.automation_id,
                channel_id,
                subscription.starts_with,
                now_ms,
            ],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(changed == 1)
}

/// Remove one Group interest. Returns whether a row existed.
pub(crate) fn unsubscribe_automation_group_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id: &str,
    channel_id: &str,
) -> Result<bool, DomainError> {
    let removed = conn
        .execute(
            "DELETE FROM automation_group_subscriptions \
             WHERE workspace_id = ?1 AND automation_id = ?2 AND channel_id = ?3",
            params![workspace_id, automation_id, channel_id],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(removed == 1)
}

/// The message a claim carries: its facts, and its body whole within
/// [`MAX_AUTOMATION_FIELD_FACTS_BYTES`] or else its size.
fn claim_message(message: &AutomationGroupMessage<'_>, channel_id: &str, lane: &str) -> Value {
    let mut value = serde_json::json!({
        "id": message.message_id,
        "threadId": message.thread_id,
        "groupId": channel_id,
        "lane": lane,
        "authorKind": message.author_kind,
        "authorDisplayName": message.author_display_name,
        "createdAtMs": message.created_at_ms,
        "body": message.body,
    });
    let object = value.as_object_mut().expect("message is an object");
    for (key, field) in [
        ("parentMessageId", message.parent_message_id),
        ("authorOwnerDisplayName", message.author_owner_display_name),
        ("authorUserId", message.author_user_id),
    ] {
        if let Some(field) = field {
            object.insert(key.to_owned(), serde_json::json!(field));
        }
    }
    if serde_json::to_vec(&value).map_or(true, |json| json.len() > MAX_AUTOMATION_FIELD_FACTS_BYTES)
    {
        value["body"] = serde_json::json!({ "truncated": true, "bytes": message.body.len() });
    }
    value
}

/// Claim a message this computer is storing, in the transaction that stores
/// it, for every Group subscription on its thread's Group whose starting text
/// the message's text begins with, after its leading whitespace. Only a
/// Group, a channel of kind `channel`, has subscriptions that claim; a DM, the
/// agent channel, and a file's thread never do. Each claim keys on the
/// message id, so a message stored again claims nothing. The writing
/// automation never claims its own message. A message at the chain depth cap
/// records a failed `chain-stopped` claim instead. Returns only the claims
/// this call inserted.
pub fn claim_group_message_in_tx(
    conn: &Connection,
    workspace_id: &str,
    message: &AutomationGroupMessage<'_>,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT s.automation_id, s.starts_with, t.channel_id, t.lane \
             FROM chat_threads t \
             JOIN chat_channels c \
               ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id \
             JOIN automation_group_subscriptions s \
               ON s.workspace_id = t.workspace_id AND s.channel_id = t.channel_id \
             WHERE t.workspace_id = ?1 AND t.thread_id = ?2 AND c.kind = 'channel' \
             ORDER BY s.automation_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let subscriptions: Vec<(String, Option<String>, String, String)> = statement
        .query_map(params![workspace_id, message.thread_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    if subscriptions.is_empty() {
        return Ok(Vec::new());
    }
    let text = message.body.trim_start_matches(is_js_trim_ws);
    let writer = message.automation_id;
    // An automation message claims at its depth, kept within 1 and the cap, so
    // a chain stops at the cap across computers. A forged high depth only
    // stops a chain early; a missing one counts as 1.
    let depth = if message.author_kind == "automation" {
        message
            .chain_depth
            .unwrap_or(1)
            .clamp(1, AUTOMATION_CHAIN_DEPTH_CAP)
    } else {
        0
    };
    let chain_stopped = depth >= AUTOMATION_CHAIN_DEPTH_CAP;
    let mut inserted = Vec::new();
    for (automation_id, starts_with, channel_id, lane) in &subscriptions {
        if writer == Some(automation_id.as_str())
            || starts_with
                .as_deref()
                .is_some_and(|prefix| !text.starts_with(prefix))
        {
            continue;
        }
        let collection_path =
            collection_automation_path(automation_id).ok_or(DomainError::StateCorrupt {
                reason: "Group subscription automation id has no Collection path",
            })?;
        let claimed = ClaimedChange {
            trigger: AutomationTrigger::Key {
                key: format!("message:{}", message.message_id),
            },
            record_id: None,
            collection_path,
            depth,
            change: AutomationChange {
                kind: AutomationChangeKind::Message,
                author_origin_id: writer.map(str::to_owned),
                actor_kind: ChangeActorKind::parse(message.author_kind),
                on_behalf_of: message.author_user_id.map(str::to_owned),
            },
            // A stopped chain never runs, so its claim keeps no message.
            fields: AutomationFieldFacts {
                message: (!chain_stopped).then(|| claim_message(message, channel_id, lane)),
                ..AutomationFieldFacts::default()
            },
            chain_stopped,
        };
        inserted.extend(insert_claims(
            conn,
            workspace_id,
            &[automation_id.as_str()],
            &claimed,
            message.created_at_ms,
        )?);
    }
    Ok(inserted)
}

/// Remove one registered interest. Returns whether a row existed.
pub(crate) fn unsubscribe_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id: &str,
    prefix: &str,
) -> Result<bool, DomainError> {
    let automation_id =
        normalize_automation_identifier(automation_id, "Automation id is invalid.")?;
    let prefix =
        normalize_automation_identifier(prefix, "Automation subscription path is invalid.")?;
    let removed = conn
        .execute(
            "DELETE FROM automation_subscriptions \
             WHERE workspace_id = ?1 AND automation_id = ?2 AND prefix = ?3",
            params![workspace_id, automation_id, prefix],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(removed == 1)
}

/// One side of a changed field as a claim carries it: whole when `whole` is
/// allowed and the value is within the `record.*` event bounds, otherwise
/// its truncated size.
fn fact_value(json: Option<&str>, whole: bool) -> Option<AutomationFactValue> {
    let json = json?;
    Some(match whole.then(|| field_fact_value(json)).flatten() {
        Some(value) => AutomationFactValue::Whole { value },
        None => AutomationFactValue::Truncated {
            truncated: true,
            bytes: json.len(),
        },
    })
}

/// One field of a change, as the bounded facts read it.
struct FieldChange<'a> {
    field_name: &'a str,
    history_id: Option<i64>,
    previous_json: Option<&'a str>,
    next_json: Option<&'a str>,
}

impl<'a> From<&'a CollectionFieldChangeFact> for FieldChange<'a> {
    fn from(change: &'a CollectionFieldChangeFact) -> Self {
        FieldChange {
            field_name: &change.field_name,
            history_id: Some(change.history_id),
            previous_json: change.previous_json.as_deref(),
            next_json: change.next_json.as_deref(),
        }
    }
}

fn field_fact(change: &FieldChange<'_>, whole: bool) -> AutomationFieldFact {
    AutomationFieldFact {
        field_name: change.field_name.to_owned(),
        history_id: change.history_id,
        previous: fact_value(change.previous_json, whole),
        next: fact_value(change.next_json, whole),
    }
}

/// A fact's share of the budget: its JSON plus the separating comma.
fn fact_bytes(fact: &AutomationFieldFact) -> usize {
    serde_json::to_vec(fact).map_or(usize::MAX, |json| json.len() + 1)
}

/// Bound one change's fields for a claim within
/// [`MAX_AUTOMATION_FIELD_FACTS_BYTES`]. Every field is named first, with
/// its values truncated; a field whose name alone does not fit is counted
/// in `omitted`. Then, in field order, values travel whole while the rest
/// of the budget allows.
fn bounded_field_facts(changes: &[FieldChange<'_>]) -> AutomationFieldFacts {
    let mut facts = AutomationFieldFacts::default();
    let mut budget = MAX_AUTOMATION_FIELD_FACTS_BYTES;
    let mut named = Vec::with_capacity(changes.len());
    for change in changes {
        let fact = field_fact(change, false);
        let bytes = fact_bytes(&fact);
        if bytes <= budget {
            budget -= bytes;
            named.push((change, fact, bytes));
        } else {
            facts.omitted += 1;
        }
    }
    for (change, truncated, truncated_bytes) in named {
        let whole = field_fact(change, true);
        let extra = fact_bytes(&whole).saturating_sub(truncated_bytes);
        if extra <= budget {
            budget -= extra;
            facts.fields.push(whole);
        } else {
            facts.fields.push(truncated);
        }
    }
    facts
}

/// Whether a changed-record subscription wants this apply: every field
/// when it names none, otherwise one of the fields it names.
fn wants_changed_fields(
    field_names_json: Option<&str>,
    changes: &[CollectionFieldChangeFact],
) -> Result<bool, DomainError> {
    let Some(field_names_json) = field_names_json else {
        return Ok(true);
    };
    let field_names: Vec<String> =
        serde_json::from_str(field_names_json).map_err(|_| DomainError::StateCorrupt {
            reason: "automation subscription fields are not a list of names",
        })?;
    Ok(changes
        .iter()
        .any(|change| field_names.contains(&change.field_name)))
}

/// One subscription as the claim paths read it.
struct SubscriptionRow {
    automation_id: String,
    prefix: String,
    field_names_json: Option<String>,
    created_at_ms: i64,
}

/// The subscriptions that want one change kind, ordered by automation id.
fn subscriptions_wanting(
    conn: &Connection,
    workspace_id: &str,
    kind: AutomationChangeKind,
) -> Result<Vec<SubscriptionRow>, DomainError> {
    let Some(column) = kind.subscription_column() else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(&format!(
            "SELECT automation_id, prefix, field_names_json, created_at_ms \
             FROM automation_subscriptions \
             WHERE workspace_id = ?1 AND {column} = 1 ORDER BY automation_id, prefix"
        ))
        .map_err(DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id], |row| {
            Ok(SubscriptionRow {
                automation_id: row.get(0)?,
                prefix: row.get(1)?,
                field_names_json: row.get(2)?,
                created_at_ms: row.get(3)?,
            })
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)
}

/// Everything one change's claims share: every claiming automation gets a
/// claim with these facts.
struct ClaimedChange<'a> {
    trigger: AutomationTrigger,
    record_id: Option<&'a str>,
    collection_path: &'a str,
    depth: u32,
    change: AutomationChange,
    fields: AutomationFieldFacts,
    chain_stopped: bool,
}

impl ClaimedChange<'_> {
    fn message_json(&self) -> Result<Option<String>, DomainError> {
        self.fields
            .message
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))
    }
}

/// Insert one claim per automation for a change. The trigger key's unique
/// index makes a repeat a no-op. Returns only the claims inserted.
fn insert_claims(
    conn: &Connection,
    workspace_id: &str,
    automation_ids: &[&str],
    claimed: &ClaimedChange<'_>,
    now_ms: i64,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let fields_json = serde_json::to_string(&claimed.fields.fields)
        .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))?;
    let message_json = claimed.message_json()?;
    let (origin_id, origin_seq, history_id, moment_order, key) = match &claimed.trigger {
        AutomationTrigger::Coordinate {
            origin_id,
            origin_seq,
        } => (
            Some(origin_id.as_str()),
            Some(*origin_seq),
            None,
            None,
            None,
        ),
        AutomationTrigger::History { history_id } => (None, None, Some(*history_id), None, None),
        AutomationTrigger::Moment { moment_order } => (None, None, None, Some(*moment_order), None),
        AutomationTrigger::Key { key } => (None, None, None, None, Some(key.as_str())),
    };
    let (state, error) = if claimed.chain_stopped {
        (AutomationClaimState::Failed, Some(AUTOMATION_CHAIN_STOPPED))
    } else {
        (AutomationClaimState::Pending, None)
    };
    let mut inserted = Vec::new();
    for automation_id in automation_ids {
        let claim_id = mint_claim_id()?;
        let rows = conn
            .execute(
                "INSERT OR IGNORE INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq, \
                  trigger_history_id, trigger_moment_order, record_id, collection_path, depth, \
                  state, attempts, error, created_at_ms, updated_at_ms, change_kind, \
                  author_origin_id, actor_kind, on_behalf_of, change_fields_json, \
                  change_fields_omitted, trigger_key, message_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?13, ?14, \
                         ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
                params![
                    workspace_id,
                    claim_id,
                    automation_id,
                    origin_id,
                    origin_seq,
                    history_id,
                    moment_order,
                    claimed.record_id,
                    claimed.collection_path,
                    i64::from(claimed.depth),
                    state.as_str(),
                    error,
                    now_ms,
                    claimed.change.kind.as_str(),
                    claimed.change.author_origin_id,
                    claimed.change.actor_kind.map(ChangeActorKind::as_str),
                    claimed.change.on_behalf_of,
                    fields_json,
                    claimed.fields.omitted,
                    key,
                    message_json,
                ],
            )
            .map_err(DomainError::sql_persist)?;
        if rows == 1 {
            inserted.push(AutomationClaim {
                claim_id,
                automation_id: (*automation_id).to_owned(),
                trigger: claimed.trigger.clone(),
                record_id: claimed.record_id.map(str::to_owned),
                collection_path: claimed.collection_path.to_owned(),
                depth: claimed.depth,
                change: claimed.change.clone(),
                state,
                attempts: 0,
                run: 1,
                error: error.map(str::to_owned),
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            });
        }
    }
    Ok(inserted)
}

/// Turn one committed local apply into pending claims, in the apply's own
/// transaction. An apply that wrote a record's fields is a changed record.
/// For each subscription that wants changed records and whose prefix
/// contains the facts' collection path, except the writing automation's own
/// subscription (an automation never re-triggers itself), insert one pending
/// claim keyed by the change's trigger key. A subscription that names fields
/// claims only when one of them changed. Each claim carries the change's
/// author and bounded field facts. Idempotent: a re-run over the same facts
/// hits the partial unique indexes and inserts nothing. Returns only the
/// claims this call inserted.
///
/// A change already at the chain depth cap runs nothing: instead of a
/// pending claim, each would-have-triggered automation records a failed
/// claim with [`AUTOMATION_CHAIN_STOPPED`], so the stop reaches the owner
/// through the same failure surface a throwing handler uses. The remote
/// apply path never calls this — ADR 0008's origin-device rule is
/// structural, not a flag check.
pub fn claim_automation_triggers_in_tx(
    conn: &Connection,
    workspace_id: &str,
    facts: &CollectionRecordApplyFacts,
    now_ms: i64,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let depth = facts
        .attribution
        .as_ref()
        .map(|attribution| attribution.depth)
        .unwrap_or(0);
    let chain_stopped = depth >= AUTOMATION_CHAIN_DEPTH_CAP;
    let trigger = match &facts.source {
        Some((origin_id, origin_seq)) => AutomationTrigger::Coordinate {
            origin_id: origin_id.clone(),
            origin_seq: *origin_seq,
        },
        None => {
            // The never-synced fallback key is the history row id. Facts
            // always carry at least one field; one without has no key.
            let Some(history_id) = facts.fields.iter().map(|field| field.history_id).min() else {
                return Ok(Vec::new());
            };
            AutomationTrigger::History { history_id }
        }
    };
    // A record's first field write is a change like any other. Reconcile
    // binds a record, indexes the fields it has, and claims it added in one
    // transaction, so an added claim with values leaves no first write
    // behind: a first write follows a record added with only its id.
    let subscriptions = subscriptions_wanting(conn, workspace_id, AutomationChangeKind::Changed)?;
    let mut claiming: Vec<&str> = Vec::new();
    for subscription in &subscriptions {
        let automation_id = subscription.automation_id.as_str();
        // One claim per automation even when several of its subscriptions
        // match (the list is ordered by automation_id).
        if claiming.last() == Some(&automation_id)
            || !prefix_contains(&subscription.prefix, &facts.collection_path)
            || facts.author_origin_id.as_deref() == Some(automation_id)
            || !wants_changed_fields(subscription.field_names_json.as_deref(), &facts.fields)?
        {
            continue;
        }
        claiming.push(automation_id);
    }
    if claiming.is_empty() {
        return Ok(Vec::new());
    }
    let changes: Vec<FieldChange<'_>> = facts.fields.iter().map(FieldChange::from).collect();
    let claimed = ClaimedChange {
        trigger,
        record_id: Some(&facts.record_id),
        collection_path: &facts.collection_path,
        depth,
        change: AutomationChange {
            kind: AutomationChangeKind::Changed,
            author_origin_id: facts.author_origin_id.clone(),
            actor_kind: facts
                .attribution
                .as_ref()
                .map(|attribution| attribution.actor_kind),
            on_behalf_of: facts
                .attribution
                .as_ref()
                .and_then(|attribution| attribution.on_behalf_of.clone()),
        },
        // A stopped chain never runs, so its claim keeps no facts.
        fields: if chain_stopped {
            AutomationFieldFacts::default()
        } else {
            bounded_field_facts(&changes)
        },
        chain_stopped,
    };
    insert_claims(conn, workspace_id, &claiming, &claimed, now_ms)
}

/// The moment that moved a record's file into or out of its Collection:
/// the claim key for an added or removed record, and the test of which
/// computer made the change.
struct LifecycleMoment {
    moment_order: i64,
    recorded_at_ms: i64,
    author_json: Option<String>,
}

/// One of an object's moments, as the lifecycle walks read them.
struct ObjectMoment {
    moment: LifecycleMoment,
    path: String,
    operation: String,
    before_present: i64,
    before_path: Option<String>,
}

/// Walk an object's moments in this version, newest first, until `decide`
/// answers. `decide` returns `Some(true)` for the moment it looks for,
/// `Some(false)` to stop without one, and `None` to go on to an older one.
fn walk_object_moments(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    decide: impl Fn(&ObjectMoment) -> Option<bool>,
) -> Result<Option<LifecycleMoment>, DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT moment_order, recorded_at_ms, author_json, path, operation, \
                    before_present, payload_before_path \
             FROM moments \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
             ORDER BY moment_order DESC",
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut rows = statement
        .query(params![workspace_id, version_id, object_id])
        .map_err(DomainError::sql_corrupt)?;
    while let Some(row) = rows.next().map_err(DomainError::sql_corrupt)? {
        let read = || -> rusqlite::Result<ObjectMoment> {
            Ok(ObjectMoment {
                moment: LifecycleMoment {
                    moment_order: row.get(0)?,
                    recorded_at_ms: row.get(1)?,
                    author_json: row.get(2)?,
                },
                path: row.get(3)?,
                operation: row.get(4)?,
                before_present: row.get(5)?,
                before_path: row.get(6)?,
            })
        };
        let moment = read().map_err(DomainError::sql_corrupt)?;
        match decide(&moment) {
            Some(true) => return Ok(Some(moment.moment)),
            Some(false) => return Ok(None),
            None => {}
        }
    }
    Ok(None)
}

/// The moment that brought an object's file into `collection_path`: the
/// newest moment that wrote the file there with no preimage (a creation;
/// `before_present = 2` records a file that existed) or renamed it in from
/// another folder. Edits inside the Collection since then are passed over.
fn entering_moment(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    collection_path: &str,
) -> Result<Option<LifecycleMoment>, DomainError> {
    walk_object_moments(conn, workspace_id, version_id, object_id, |moment| {
        let inside = parent_path(&moment.path) == collection_path;
        let entered = inside
            && match moment.operation.as_str() {
                "write" => moment.before_present != 2,
                "rename" => moment
                    .before_path
                    .as_deref()
                    .is_none_or(|before| parent_path(before) != collection_path),
                _ => false,
            };
        entered.then_some(true)
    })
}

/// The moment that took an object's file out of `collection_path`: walking
/// back from the newest, the first moment that deleted the file there or
/// renamed it from there into another folder. Edits made after the file
/// left are passed over. `None` when the file is still in the Collection
/// (its frontmatter broke, or the Collection itself went away).
fn leaving_moment(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    collection_path: &str,
) -> Result<Option<LifecycleMoment>, DomainError> {
    walk_object_moments(conn, workspace_id, version_id, object_id, |moment| {
        let inside = parent_path(&moment.path) == collection_path;
        match moment.operation.as_str() {
            "delete" if inside => Some(true),
            "rename"
                if !inside
                    && moment
                        .before_path
                        .as_deref()
                        .is_some_and(|before| parent_path(before) == collection_path) =>
            {
                Some(true)
            }
            // The file is in the Collection at this moment, and nothing
            // newer took it out.
            _ if inside => Some(false),
            _ => None,
        }
    })
}

/// When `collection_path` last became a Collection in this version: the
/// moment its schema file arrived at the schema path, created there or
/// renamed to it (from the same folder too). A file that entered the folder
/// before it cannot have been added to the Collection. `None` when the
/// schema predates the version (a fork copies files, not their moments), as
/// every file that entered before the fork does.
fn collection_since(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
) -> Result<Option<i64>, DomainError> {
    let schema: Option<(String, String)> = conn
        .query_row(
            "SELECT s.object_id, c.schema_path FROM collections c JOIN snapshots s \
               ON s.workspace_id = c.workspace_id AND s.version_id = c.version_id \
              AND s.path = c.schema_path \
             WHERE c.workspace_id = ?1 AND c.version_id = ?2 AND c.collection_path = ?3",
            params![workspace_id, version_id, collection_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((schema_object, schema_path)) = schema else {
        return Ok(None);
    };
    let arrived = walk_object_moments(conn, workspace_id, version_id, &schema_object, |moment| {
        let arrived = moment.path == schema_path
            && match moment.operation.as_str() {
                "write" => moment.before_present != 2,
                "rename" => moment.before_path.as_deref() != Some(schema_path.as_str()),
                _ => false,
            };
        arrived.then_some(true)
    })?;
    Ok(arrived.map(|moment| moment.moment_order))
}

/// Whether a moment is a merge's: the merge replayed a change another
/// version made, which claimed where it was made.
fn moment_is_merged(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM merged_moments \
         WHERE workspace_id = ?1 AND moment_order = ?2)",
        params![workspace_id, moment_order],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

/// Whether a moment was committed on this computer, by the rule sync
/// enrolment uses to decide which moments are this computer's to journal:
/// no replication import wrote it, or its import was refused and the
/// refusal is still pending.
fn moment_is_local(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT NOT EXISTS ( \
             SELECT 1 FROM moments m JOIN replication_log r \
               ON r.workspace_id = m.workspace_id AND r.op_kind = 'moment.append' \
              AND json_extract(r.payload_json, '$.momentId') = m.moment_id \
             WHERE m.workspace_id = ?1 AND m.moment_order = ?2 AND r.imported = 1 \
               AND NOT EXISTS (SELECT 1 FROM replication_pending_refusals p \
                 WHERE p.workspace_id = r.workspace_id AND p.origin_id = r.origin_id \
                   AND p.origin_seq = r.origin_seq))",
        params![workspace_id, moment_order],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

/// A moment's author as a claim names it, with the chain depth it declared
/// ([`moment_author_attribution`]).
fn moment_change(kind: AutomationChangeKind, author_json: Option<&str>) -> (AutomationChange, u32) {
    let (author_origin_id, attribution) = moment_author_attribution(author_json);
    let change = AutomationChange {
        kind,
        author_origin_id,
        actor_kind: attribution
            .as_ref()
            .map(|attribution| attribution.actor_kind),
        on_behalf_of: attribution
            .as_ref()
            .and_then(|attribution| attribution.on_behalf_of.clone()),
    };
    (
        change,
        attribution.map_or(0, |attribution| attribution.depth),
    )
}

/// Whether any automation wants removed records, so reconcile reads a
/// removed record's last values before the index drops them.
pub(crate) fn removed_records_wanted_in_tx(
    conn: &Connection,
    workspace_id: &str,
) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM automation_subscriptions \
         WHERE workspace_id = ?1 AND on_removed = 1)",
        params![workspace_id],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

/// Turn one reconcile's added and removed records into pending claims, in
/// the reconcile's own transaction. A record claims only when a moment
/// committed on this computer moved its file into the Collection (added) or
/// out of it (removed), and only for subscriptions that existed when that
/// moment was recorded. The moment's declared author sets the claim's
/// author and chain depth, so the self-trigger guard and the depth cap apply
/// as they do to field changes. Everything else that binds or unbinds a record,
/// such as a Collection appearing or disappearing, frontmatter breaking or
/// healing, or a synced moment from another computer, claims nothing. The
/// key is the moment and the kind, so a record whose binding a later
/// reconcile derives again is not claimed twice. An added record's claim
/// lists its fields; a removed record's lists its last known values.
pub fn claim_record_lifecycle_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    lifecycle: &[CollectionRecordLifecycle],
    now_ms: i64,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let mut inserted = Vec::new();
    let mut collection_since: std::collections::HashMap<&str, Option<i64>> =
        std::collections::HashMap::new();
    for kind in [AutomationChangeKind::Added, AutomationChangeKind::Removed] {
        let records: Vec<&CollectionRecordLifecycle> = lifecycle
            .iter()
            .filter(|record| match record.kind {
                CollectionRecordLifecycleKind::Added => kind == AutomationChangeKind::Added,
                CollectionRecordLifecycleKind::Removed => kind == AutomationChangeKind::Removed,
            })
            .collect();
        if records.is_empty() {
            continue;
        }
        let subscriptions = subscriptions_wanting(conn, workspace_id, kind)?;
        if subscriptions.is_empty() {
            continue;
        }
        for record in records {
            let moment = match kind {
                AutomationChangeKind::Added => entering_moment(
                    conn,
                    workspace_id,
                    version_id,
                    &record.object_id,
                    &record.collection_path,
                )?,
                _ => leaving_moment(
                    conn,
                    workspace_id,
                    version_id,
                    &record.object_id,
                    &record.collection_path,
                )?,
            };
            let Some(moment) = moment else {
                continue;
            };
            // A file that entered the folder before it became a Collection
            // was not added to it: the Collection appeared around it.
            if kind == AutomationChangeKind::Added {
                let since = match collection_since.get(record.collection_path.as_str()) {
                    Some(since) => *since,
                    None => {
                        let since = self::collection_since(
                            conn,
                            workspace_id,
                            version_id,
                            &record.collection_path,
                        )?;
                        collection_since.insert(&record.collection_path, since);
                        since
                    }
                };
                if since.is_some_and(|since| moment.moment_order <= since) {
                    continue;
                }
            }
            if !moment_is_local(conn, workspace_id, moment.moment_order)?
                || moment_is_merged(conn, workspace_id, moment.moment_order)?
            {
                continue;
            }
            let (change, depth) = moment_change(kind, moment.author_json.as_deref());
            let chain_stopped = depth >= AUTOMATION_CHAIN_DEPTH_CAP;
            let mut claiming: Vec<&str> = Vec::new();
            for subscription in &subscriptions {
                let automation_id = subscription.automation_id.as_str();
                if claiming.last() == Some(&automation_id)
                    || !prefix_contains(&subscription.prefix, &record.collection_path)
                    || subscription.created_at_ms > moment.recorded_at_ms
                    || change.author_origin_id.as_deref() == Some(automation_id)
                {
                    continue;
                }
                claiming.push(automation_id);
            }
            if claiming.is_empty() {
                continue;
            }
            // An added record's values are in the index now; a removed
            // record's were read before the index dropped them.
            let added_fields = match kind {
                AutomationChangeKind::Added if !chain_stopped => {
                    indexed_record_fields(conn, workspace_id, version_id, &record.record_id)?
                }
                _ => Vec::new(),
            };
            let values = match kind {
                AutomationChangeKind::Added => &added_fields,
                _ => &record.removed_fields,
            };
            let changes: Vec<FieldChange<'_>> = values
                .iter()
                .map(|(field_name, value_json)| {
                    let value = Some(value_json.as_str());
                    FieldChange {
                        field_name,
                        history_id: None,
                        previous_json: (kind == AutomationChangeKind::Removed)
                            .then_some(value)
                            .flatten(),
                        next_json: (kind == AutomationChangeKind::Added)
                            .then_some(value)
                            .flatten(),
                    }
                })
                .collect();
            let claimed = ClaimedChange {
                trigger: AutomationTrigger::Moment {
                    moment_order: moment.moment_order,
                },
                record_id: Some(&record.record_id),
                collection_path: &record.collection_path,
                depth,
                change,
                // A stopped chain never runs, so its claim keeps no facts.
                fields: if chain_stopped {
                    AutomationFieldFacts::default()
                } else {
                    bounded_field_facts(&changes)
                },
                chain_stopped,
            };
            inserted.extend(insert_claims(
                conn,
                workspace_id,
                &claiming,
                &claimed,
                now_ms,
            )?);
        }
    }
    Ok(inserted)
}

/// How long this computer remembers a button press, so the same press sent
/// again, after a reply was lost, finds its claim instead of running twice.
pub const AUTOMATION_PRESS_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// How far behind its schedule's mark a done schedule claim keeps its key.
/// Main moves a changed schedule's mark to now, so only a clock set back
/// could reach an older due time again, and this covers that.
pub const AUTOMATION_SCHEDULE_KEY_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The most due times one `automations.claimSchedule` call runs. A scheduler
/// runs the times it reached and skips the ones it missed, so a call
/// normally runs one.
pub const MAX_AUTOMATION_SCHEDULE_RUNS: usize = 100;

/// A person pressed a Button field on a record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationPress {
    /// The pressing window's id for this press. A press sent again after a
    /// lost reply carries the same id.
    pub press_id: String,
    /// The automation the button runs: `collection:<collection path>#<id>`.
    pub automation_id: String,
    pub record_id: String,
    /// The person who pressed. The run acts for them.
    pub pressed_by: String,
}

/// What `automations.press` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationPressed {
    /// The press inserted a pending claim.
    Claimed(AutomationClaim),
    /// The same person's press already has this claim: the press was sent
    /// again, or the button was already running for them on the record.
    Joined(AutomationClaim),
    /// The button is already running on the record for another person.
    /// Their claim acts for them, so this press gets none.
    Busy,
}

/// The Collection path of the Collection automation a button or schedule
/// runs.
fn button_or_schedule_collection(automation_id: &str) -> Result<&str, DomainError> {
    collection_automation_path(automation_id).ok_or(DomainError::InvalidInput {
        reason: "Buttons and schedules run Collection automations, collection:<path>#<id>.",
    })
}

/// Record one button press and answer the claim that runs it, in one
/// transaction. A button claim acts for the one person who pressed, so a
/// press only ever joins that person's claim:
///
/// - A press id this computer remembers, or the key `press:<press id>` of
///   a claim it still holds on any button, answers that claim.
/// - When the automation already has a pending or running claim for the
///   record, the same person's press joins it, so a double click or two
///   windows run once. Another person's press is
///   [`AutomationPressed::Busy`] and records nothing.
/// - Otherwise the press inserts a pending claim keyed `press:<press id>`,
///   at depth 0, acting for the person who pressed.
///
/// A press id that names another person's press, or another button or
/// record, is refused. Presses older than [`AUTOMATION_PRESS_RETENTION_MS`]
/// are forgotten first, and claim pruning skips a claim a remembered press
/// names.
pub fn press_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    press: &AutomationPress,
    now_ms: i64,
) -> Result<AutomationPressed, DomainError> {
    let collection_path = button_or_schedule_collection(&press.automation_id)?;
    let press_id = normalize_automation_identifier(&press.press_id, "Button press id is invalid.")?;
    let record_id =
        normalize_automation_identifier(&press.record_id, "Button record id is invalid.")?;
    let pressed_by = normalize_automation_identifier(
        &press.pressed_by,
        "The person who pressed the button is invalid.",
    )?;
    let another_press = DomainError::InvalidInput {
        reason: "This press id already names another person's press, or another button or record.",
    };
    conn.execute(
        "DELETE FROM automation_presses WHERE workspace_id = ?1 AND pressed_at_ms < ?2",
        params![
            workspace_id,
            now_ms.saturating_sub(AUTOMATION_PRESS_RETENTION_MS)
        ],
    )
    .map_err(DomainError::sql_persist)?;
    let remembered: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT automation_id, record_id, pressed_by, claim_id FROM automation_presses \
             WHERE workspace_id = ?1 AND press_id = ?2",
            params![workspace_id, press_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if let Some((automation_id, remembered_record, remembered_by, claim_id)) = remembered {
        if automation_id != press.automation_id
            || remembered_record != record_id
            || remembered_by != pressed_by
        {
            return Err(another_press);
        }
        return claim_by_id(conn, workspace_id, &claim_id)?
            .map(AutomationPressed::Joined)
            .ok_or(DomainError::StateCorrupt {
                reason: "a remembered button press lost its claim",
            });
    }
    // A press this computer forgot can still have its claim, on any button.
    let key = format!("press:{press_id}");
    let keyed: Option<String> = conn
        .query_row(
            "SELECT claim_id FROM automation_claims \
             WHERE workspace_id = ?1 AND trigger_key = ?2 AND change_kind = 'button' \
             ORDER BY created_at_ms, claim_id LIMIT 1",
            params![workspace_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let active: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT claim_id, on_behalf_of FROM automation_claims \
             WHERE workspace_id = ?1 AND automation_id = ?2 AND record_id = ?3 \
               AND change_kind = 'button' AND state IN ('pending', 'running')",
            params![workspace_id, press.automation_id, record_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let existing = |claim_id: &str| -> Result<AutomationClaim, DomainError> {
        claim_by_id(conn, workspace_id, claim_id)?.ok_or(DomainError::StateCorrupt {
            reason: "a button claim vanished under the single writer",
        })
    };
    let (claim, inserted) = match (keyed, active) {
        (Some(claim_id), _) => {
            let claim = existing(&claim_id)?;
            if claim.automation_id != press.automation_id
                || claim.record_id.as_deref() != Some(record_id.as_str())
                || claim.change.on_behalf_of.as_deref() != Some(pressed_by.as_str())
            {
                return Err(another_press);
            }
            (claim, false)
        }
        (None, Some((claim_id, on_behalf_of))) => {
            if on_behalf_of.as_deref() != Some(pressed_by.as_str()) {
                return Ok(AutomationPressed::Busy);
            }
            (existing(&claim_id)?, false)
        }
        (None, None) => {
            let claimed = ClaimedChange {
                trigger: AutomationTrigger::Key { key },
                record_id: Some(record_id.as_str()),
                collection_path,
                depth: 0,
                change: AutomationChange {
                    kind: AutomationChangeKind::Button,
                    author_origin_id: None,
                    actor_kind: Some(ChangeActorKind::Human),
                    on_behalf_of: Some(pressed_by.clone()),
                },
                fields: AutomationFieldFacts::default(),
                chain_stopped: false,
            };
            let claim = insert_claims(
                conn,
                workspace_id,
                &[press.automation_id.as_str()],
                &claimed,
                now_ms,
            )?
            .pop()
            .ok_or(DomainError::StateCorrupt {
                reason: "a new button press claimed nothing",
            })?;
            (claim, true)
        }
    };
    conn.execute(
        "INSERT INTO automation_presses \
         (workspace_id, press_id, automation_id, record_id, pressed_by, pressed_at_ms, claim_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            workspace_id,
            press_id,
            press.automation_id,
            record_id,
            pressed_by,
            now_ms,
            claim.claim_id
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(if inserted {
        AutomationPressed::Claimed(claim)
    } else {
        AutomationPressed::Joined(claim)
    })
}

/// How far one schedule has been claimed or skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationScheduleMark {
    pub automation_id: String,
    /// The scheduler's hash of the schedule the mark counts for. A changed
    /// schedule starts a new mark.
    pub schedule_hash: String,
    /// Every due time at or before this was claimed or skipped.
    pub through_ms: i64,
}

/// One scheduler step for one schedule: the due times it runs and where the
/// mark moves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationScheduleClaim {
    pub automation_id: String,
    pub schedule_hash: String,
    /// Due times to run, each after the stored mark and at or before
    /// `through_ms`. At most [`MAX_AUTOMATION_SCHEDULE_RUNS`].
    pub run: Vec<i64>,
    /// The mark's new position. A due time between the stored mark and this
    /// one that is not in `run` is skipped.
    pub through_ms: i64,
}

/// What one scheduler step claimed, and the schedule's mark after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationScheduleClaimed {
    pub claims: Vec<AutomationClaim>,
    pub mark: AutomationScheduleMark,
}

/// Claim a schedule's due times and move its mark, in one transaction. Each
/// due time claims once, keyed `schedule:<due ms>`, with no record, at depth
/// 0. A done schedule claim keeps its key when a settle prunes, so a due
/// time never claims twice. A time at or before the stored mark is refused,
/// and the mark never moves back: a step that runs nothing and would move
/// it back, as after this computer's clock was set back, changes nothing
/// and answers the stored mark so the scheduler can catch up. A new
/// automation, a changed schedule, or a switch-on starts the mark: when no
/// mark exists for the automation, or the stored mark counts a different
/// schedule, the call only sets the mark, so it runs nothing. Answers the
/// claims inserted and the mark.
pub fn claim_automation_schedule_in_tx(
    conn: &Connection,
    workspace_id: &str,
    schedule: &AutomationScheduleClaim,
    now_ms: i64,
) -> Result<AutomationScheduleClaimed, DomainError> {
    let collection_path = button_or_schedule_collection(&schedule.automation_id)?;
    let schedule_hash =
        normalize_automation_identifier(&schedule.schedule_hash, "Schedule hash is invalid.")?;
    if schedule.run.len() > MAX_AUTOMATION_SCHEDULE_RUNS {
        return Err(DomainError::InvalidInput {
            reason: "A schedule claim runs at most 100 due times.",
        });
    }
    let stored: Option<(String, i64)> = conn
        .query_row(
            "SELECT schedule_hash, through_ms FROM automation_schedule_marks \
             WHERE workspace_id = ?1 AND automation_id = ?2",
            params![workspace_id, schedule.automation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let mut inserted = Vec::new();
    match stored {
        Some((hash, through_ms)) if hash == schedule_hash => {
            if schedule.through_ms < through_ms && schedule.run.is_empty() {
                return Ok(AutomationScheduleClaimed {
                    claims: Vec::new(),
                    mark: AutomationScheduleMark {
                        automation_id: schedule.automation_id.clone(),
                        schedule_hash,
                        through_ms,
                    },
                });
            }
            if schedule.through_ms < through_ms {
                return Err(DomainError::InvalidInput {
                    reason: "A schedule's mark cannot move back.",
                });
            }
            if schedule
                .run
                .iter()
                .any(|due_ms| *due_ms <= through_ms || *due_ms > schedule.through_ms)
            {
                return Err(DomainError::InvalidInput {
                    reason: "A due time must be after the schedule's mark and at or before its new mark.",
                });
            }
            for due_ms in &schedule.run {
                let claimed = ClaimedChange {
                    trigger: AutomationTrigger::Key {
                        key: format!("schedule:{due_ms}"),
                    },
                    record_id: None,
                    collection_path,
                    depth: 0,
                    change: AutomationChange {
                        kind: AutomationChangeKind::Schedule,
                        author_origin_id: None,
                        actor_kind: None,
                        on_behalf_of: None,
                    },
                    fields: AutomationFieldFacts::default(),
                    chain_stopped: false,
                };
                inserted.extend(insert_claims(
                    conn,
                    workspace_id,
                    &[schedule.automation_id.as_str()],
                    &claimed,
                    now_ms,
                )?);
            }
        }
        _ if !schedule.run.is_empty() => {
            return Err(DomainError::InvalidInput {
                reason: "A new or changed schedule sets its mark before it runs a due time.",
            });
        }
        _ => {}
    }
    conn.execute(
        "INSERT INTO automation_schedule_marks \
         (workspace_id, automation_id, schedule_hash, through_ms) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(workspace_id, automation_id) DO UPDATE SET \
           schedule_hash = excluded.schedule_hash, through_ms = excluded.through_ms",
        params![
            workspace_id,
            schedule.automation_id,
            schedule_hash,
            schedule.through_ms
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(AutomationScheduleClaimed {
        claims: inserted,
        mark: AutomationScheduleMark {
            automation_id: schedule.automation_id.clone(),
            schedule_hash,
            through_ms: schedule.through_ms,
        },
    })
}

/// The owner chose Run now on a schedule's skipped-run notice. Insert one
/// pending claim keyed `run-now:<notice id>`, with no record, at depth 0,
/// like a schedule's due time. The notice's first dismissal on the relay
/// picks the one computer that runs it; the key keeps a repeat on this
/// computer from running it twice, so a run-now claim is never pruned.
/// Answers the claim, and whether this call inserted it.
pub fn claim_automation_run_now_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id: &str,
    notice_id: &str,
    now_ms: i64,
) -> Result<AutomationRunNow, DomainError> {
    let collection_path = button_or_schedule_collection(automation_id)?;
    let notice_id = normalize_automation_identifier(notice_id, "Notice id is invalid.")?;
    let key = format!("run-now:{notice_id}");
    let existing: Option<String> = conn
        .query_row(
            "SELECT claim_id FROM automation_claims \
             WHERE workspace_id = ?1 AND automation_id = ?2 AND trigger_key = ?3",
            params![workspace_id, automation_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if let Some(claim_id) = existing {
        let claim =
            claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
                reason: "A run-now claim disappeared inside its own transaction.",
            })?;
        return Ok(AutomationRunNow {
            claim,
            inserted: false,
        });
    }
    let claimed = ClaimedChange {
        trigger: AutomationTrigger::Key { key },
        record_id: None,
        collection_path,
        depth: 0,
        change: AutomationChange {
            kind: AutomationChangeKind::Schedule,
            author_origin_id: None,
            actor_kind: None,
            on_behalf_of: None,
        },
        fields: AutomationFieldFacts::default(),
        chain_stopped: false,
    };
    let claim = insert_claims(conn, workspace_id, &[automation_id], &claimed, now_ms)?
        .into_iter()
        .next()
        .ok_or(DomainError::StateCorrupt {
            reason: "A run-now claim was neither found nor inserted.",
        })?;
    Ok(AutomationRunNow {
        claim,
        inserted: true,
    })
}

/// A Run now claim, and whether this call inserted it rather than found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRunNow {
    pub claim: AutomationClaim,
    pub inserted: bool,
}

/// Every schedule mark in the workspace, ordered by automation id.
pub(crate) fn list_automation_schedule_marks_in_tx(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<AutomationScheduleMark>, DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT automation_id, schedule_hash, through_ms FROM automation_schedule_marks \
             WHERE workspace_id = ?1 ORDER BY automation_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id], |row| {
            Ok(AutomationScheduleMark {
                automation_id: row.get(0)?,
                schedule_hash: row.get(1)?,
                through_ms: row.get(2)?,
            })
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)
}

/// One failed-claim summary per automation, for the owner-visible failure
/// surface: the newest failed claim, its error and time, plus a generation.
/// The generation counts every time one of the automation's claims failed:
/// each earlier run of a claim failed once (a retry follows a failure), and
/// a failed claim's current run once more. A claim that ever failed is never
/// pruned (a dismiss acknowledges, it does not destroy evidence), so the
/// generation only grows, even across a retry, and an acknowledgment at
/// generation N hides the notice exactly until a newer failure raises it
/// past N.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationFailure {
    pub automation_id: String,
    /// The newest failed claim, so the owner's Try again can name it.
    pub claim_id: String,
    /// Whether the newest failed claim is a chain stop, which no retry can
    /// run ([`AutomationClaim::chain_stopped`]).
    pub chain_stopped: bool,
    pub error: String,
    pub updated_at_ms: i64,
    pub generation: i64,
}

/// Every automation with at least one failed claim in this workspace,
/// ordered by automation id.
pub(crate) fn list_automation_failures_in_tx(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<AutomationFailure>, DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT newest.automation_id, newest.claim_id, newest.attempts = 0, newest.error, \
                    newest.updated_at_ms, \
                    (SELECT SUM(every.run - 1 + (every.state = 'failed')) \
                     FROM automation_claims every \
                     WHERE every.workspace_id = ?1 \
                       AND every.automation_id = newest.automation_id) \
             FROM ( \
                 SELECT automation_id, claim_id, attempts, error, updated_at_ms, \
                        ROW_NUMBER() OVER ( \
                            PARTITION BY automation_id \
                            ORDER BY updated_at_ms DESC, claim_id DESC \
                        ) AS rank \
                 FROM automation_claims \
                 WHERE workspace_id = ?1 AND state = 'failed' \
             ) newest WHERE newest.rank = 1 ORDER BY newest.automation_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let failures = statement
        .query_map(params![workspace_id], |row| {
            let error: Option<String> = row.get(3)?;
            Ok(AutomationFailure {
                automation_id: row.get(0)?,
                claim_id: row.get(1)?,
                chain_stopped: row.get(2)?,
                // A failed claim always records why; a NULL here would be
                // corruption, surfaced as an empty reason rather than a
                // refused listing.
                error: error.unwrap_or_default(),
                updated_at_ms: row.get(4)?,
                generation: row.get(5)?,
            })
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(DomainError::sql_corrupt)?;
    Ok(failures)
}

fn claim_field_facts(
    conn: &Connection,
    workspace_id: &str,
    claim_id: &str,
) -> Result<AutomationFieldFacts, DomainError> {
    let (fields_json, omitted, message_json): (String, u32, Option<String>) = conn
        .query_row(
            "SELECT change_fields_json, change_fields_omitted, message_json FROM automation_claims \
             WHERE workspace_id = ?1 AND claim_id = ?2",
            params![workspace_id, claim_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(DomainError::sql_corrupt)?;
    let fields = serde_json::from_str(&fields_json).map_err(|_| DomainError::StateCorrupt {
        reason: "automation claim field facts are not valid facts",
    })?;
    let message = message_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|_| DomainError::StateCorrupt {
            reason: "automation claim message is not valid JSON",
        })?;
    Ok(AutomationFieldFacts {
        fields,
        omitted,
        message,
    })
}

/// Flip the oldest pending claim whose automation id starts with the prefix
/// to running with `attempts + 1`, and return it with its field facts;
/// `None` when nothing is pending. The Collection executor drains
/// [`AUTOMATION_ID_NAMESPACE`].
pub(crate) fn claim_next_pending_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id_prefix: &str,
    now_ms: i64,
) -> Result<Option<(AutomationClaim, AutomationFieldFacts)>, DomainError> {
    if automation_id_prefix.is_empty()
        || automation_id_prefix.len() > MAX_IDENTIFIER_BYTES
        || automation_id_prefix.contains('\0')
    {
        return Err(DomainError::InvalidInput {
            reason: "Automation id prefix is invalid.",
        });
    }
    let claim_id: Option<String> = conn
        .query_row(
            "SELECT claim_id FROM automation_claims \
             WHERE workspace_id = ?1 AND state = 'pending' \
               AND substr(automation_id, 1, length(?2)) = ?2 \
             ORDER BY created_at_ms, claim_id LIMIT 1",
            params![workspace_id, automation_id_prefix],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some(claim_id) = claim_id else {
        return Ok(None);
    };
    let rows = conn
        .execute(
            "UPDATE automation_claims \
             SET state = 'running', attempts = attempts + 1, updated_at_ms = ?3 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'pending'",
            params![workspace_id, claim_id, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if rows != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "automation claim vanished mid-claim under the single writer",
        });
    }
    let claim = claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
        reason: "claimed automation row not found after update",
    })?;
    let facts = claim_field_facts(conn, workspace_id, &claim_id)?;
    Ok(Some((claim, facts)))
}

/// An automation's newest claims in every state, newest first, at most
/// [`AUTOMATION_CLAIM_HISTORY_LIMIT`]: its run history.
pub(crate) fn list_automation_claims_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id: &str,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let automation_id =
        normalize_automation_identifier(automation_id, "Automation id is invalid.")?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT {CLAIM_COLUMNS} FROM automation_claims \
             WHERE workspace_id = ?1 AND automation_id = ?2 \
             ORDER BY created_at_ms DESC, claim_id DESC LIMIT ?3"
        ))
        .map_err(DomainError::sql_corrupt)?;
    statement
        .query_map(
            params![workspace_id, automation_id, AUTOMATION_CLAIM_HISTORY_LIMIT],
            claim_from_row,
        )
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(DomainError::sql_corrupt)?
        .into_iter()
        .collect()
}

/// What `automations.retry` did to a claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationRetry {
    /// The failed claim is pending again as its next run.
    Requeued(AutomationClaim),
    /// The claim was already pending or running; nothing changed.
    Unchanged(AutomationClaim),
}

/// Queue a failed claim to run again with the facts it already holds, as its
/// next run. A claim already pending or running is returned unchanged. A
/// done claim, and a claim the chain depth cap stopped, cannot run again.
pub(crate) fn retry_automation_claim_in_tx(
    conn: &Connection,
    workspace_id: &str,
    claim_id: &str,
    now_ms: i64,
) -> Result<AutomationRetry, DomainError> {
    let claim_id = normalize_automation_identifier(claim_id, "Automation claim id is invalid.")?;
    let existing =
        claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::InvalidInput {
            reason: "Automation claim not found.",
        })?;
    if existing.chain_stopped() {
        return Err(DomainError::InvalidInput {
            reason: "A claim the chain depth cap stopped cannot run.",
        });
    }
    match existing.state {
        AutomationClaimState::Pending | AutomationClaimState::Running => {
            return Ok(AutomationRetry::Unchanged(existing));
        }
        AutomationClaimState::Done => {
            return Err(DomainError::InvalidInput {
                reason: "Automation claim is done.",
            });
        }
        AutomationClaimState::Failed => {}
    }
    if existing.change.kind == AutomationChangeKind::Button {
        let busy: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM automation_claims \
                 WHERE workspace_id = ?1 AND automation_id = ?2 AND record_id = ?3 \
                   AND change_kind = 'button' AND state IN ('pending', 'running'))",
                params![workspace_id, existing.automation_id, existing.record_id],
                |row| row.get(0),
            )
            .map_err(DomainError::sql_corrupt)?;
        if busy {
            return Err(DomainError::InvalidInput {
                reason: "This button is already running for this record.",
            });
        }
    }
    let rows = conn
        .execute(
            "UPDATE automation_claims \
             SET state = 'pending', error = NULL, run = run + 1, updated_at_ms = ?3 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'failed'",
            params![workspace_id, claim_id, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if rows != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "automation claim vanished mid-retry under the single writer",
        });
    }
    claim_by_id(conn, workspace_id, &claim_id)?
        .ok_or(DomainError::StateCorrupt {
            reason: "retried automation claim not found after update",
        })
        .map(AutomationRetry::Requeued)
}

/// Hand a running claim back without running it, when its executor cannot
/// run it yet: its roster is unknown, a step is held, the evaluator is busy,
/// or a check before the run failed. The claim is pending again with the
/// attempts it had before `claimNext` served it (a release is not an
/// attempt) and the same run. The reaper watches running claims only, so a
/// released claim cannot linger behind a dead holder, and its next serve
/// starts the reaper's clock again. Refuses a claim that is not running.
pub(crate) fn release_automation_claim_in_tx(
    conn: &Connection,
    workspace_id: &str,
    claim_id: &str,
    now_ms: i64,
) -> Result<AutomationClaim, DomainError> {
    let claim_id = normalize_automation_identifier(claim_id, "Automation claim id is invalid.")?;
    let existing =
        claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::InvalidInput {
            reason: "Automation claim not found.",
        })?;
    if existing.state != AutomationClaimState::Running {
        return Err(DomainError::InvalidInput {
            reason: "Automation claim is not running.",
        });
    }
    let rows = conn
        .execute(
            "UPDATE automation_claims \
             SET state = 'pending', attempts = attempts - 1, updated_at_ms = ?3 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'running' AND attempts > 0",
            params![workspace_id, claim_id, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if rows != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "running automation claim has no attempt to release",
        });
    }
    claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
        reason: "released automation claim not found after update",
    })
}

/// Close a running claim: done, or failed with the handler's error text.
/// Refuses a claim that is not running — a settle is not idempotent, matching
/// the chat ledger's exactly-one-transition rule. Then prunes the
/// automation's done claims past its newest
/// [`AUTOMATION_CLAIM_HISTORY_LIMIT`]; a claim that ever failed stays.
pub(crate) fn settle_automation_claim_in_tx(
    conn: &Connection,
    workspace_id: &str,
    claim_id: &str,
    settle: &AutomationSettle,
    now_ms: i64,
) -> Result<AutomationClaim, DomainError> {
    let claim_id = normalize_automation_identifier(claim_id, "Automation claim id is invalid.")?;
    let (state, error) = match settle {
        AutomationSettle::Done => (AutomationClaimState::Done, None),
        AutomationSettle::Failed { error } => {
            let error = error.trim();
            if error.is_empty() || error.len() > MAX_AUTOMATION_ERROR_BYTES {
                return Err(DomainError::InvalidInput {
                    reason: "Automation failure text must be non-empty and bounded.",
                });
            }
            (AutomationClaimState::Failed, Some(error.to_owned()))
        }
    };
    let existing =
        claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::InvalidInput {
            reason: "Automation claim not found.",
        })?;
    if existing.state != AutomationClaimState::Running {
        return Err(DomainError::InvalidInput {
            reason: "Automation claim is not running.",
        });
    }
    let rows = conn
        .execute(
            "UPDATE automation_claims \
             SET state = ?3, error = ?4, updated_at_ms = ?5 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'running'",
            params![workspace_id, claim_id, state.as_str(), error, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if rows != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "automation claim vanished mid-settle under the single writer",
        });
    }
    let settled = claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
        reason: "settled automation claim not found after update",
    })?;
    // Past the history, a done field claim goes. A done added or removed
    // claim keeps its row, without facts: a later reconcile can derive the
    // same moment again (a record whose frontmatter broke and healed), and
    // the row's key is what keeps it from claiming twice. A done message
    // claim keeps its key without its message for the same reason: a message
    // stored again after its thread was removed must not run twice. A done
    // schedule claim keeps its key until its due time is
    // AUTOMATION_SCHEDULE_KEY_RETENTION_MS behind the schedule's mark, so a
    // due time a reset mark reaches again does not run twice. A done button
    // claim stays while a remembered press names it, so the press sent
    // again finds it.
    let prune = params![
        workspace_id,
        settled.automation_id,
        AUTOMATION_CLAIM_HISTORY_LIMIT
    ];
    conn.execute(PRUNE_SETTLED_RECORD_CLAIMS_SQL, prune)
        .map_err(DomainError::sql_persist)?;
    conn.execute(
        PRUNE_AGED_SCHEDULE_KEYS_SQL,
        params![
            workspace_id,
            settled.automation_id,
            AUTOMATION_CLAIM_HISTORY_LIMIT,
            AUTOMATION_SCHEDULE_KEY_RETENTION_MS
        ],
    )
    .map_err(DomainError::sql_persist)?;
    conn.execute(CLEAR_SETTLED_CLAIM_FACTS_SQL, prune)
        .map_err(DomainError::sql_persist)?;
    Ok(settled)
}

/// Delete an automation's settled record and button claims past its
/// history, except a button claim a kept press names. The terms
/// before `claim_id` match `idx_automation_claims_prunable`, so the delete
/// never reads the key rows message claims keep. It does read the schedule
/// claims it keeps, whose key rows last about 30 days.
pub(crate) const PRUNE_SETTLED_RECORD_CLAIMS_SQL: &str = "DELETE FROM automation_claims \
     WHERE workspace_id = ?1 AND automation_id = ?2 AND state = 'done' AND run = 1 \
       AND trigger_moment_order IS NULL AND change_kind <> 'message' \
       AND change_kind <> 'schedule' \
       AND NOT EXISTS (SELECT 1 FROM automation_presses p \
         WHERE p.workspace_id = automation_claims.workspace_id \
           AND p.claim_id = automation_claims.claim_id) \
       AND claim_id NOT IN ( \
           SELECT claim_id FROM automation_claims \
           WHERE workspace_id = ?1 AND automation_id = ?2 \
           ORDER BY created_at_ms DESC, claim_id DESC LIMIT ?3)";

/// Delete an automation's settled schedule claims past its history whose due
/// time is more than `?4` behind the schedule's mark. The `<> 'message'`
/// term matches `idx_automation_claims_prunable`.
pub(crate) const PRUNE_AGED_SCHEDULE_KEYS_SQL: &str = "DELETE FROM automation_claims \
     WHERE workspace_id = ?1 AND automation_id = ?2 AND state = 'done' AND run = 1 \
       AND trigger_moment_order IS NULL AND change_kind <> 'message' \
       AND change_kind = 'schedule' AND substr(trigger_key, 1, 9) = 'schedule:' \
       AND CAST(substr(trigger_key, length('schedule:') + 1) AS INTEGER) < ( \
           SELECT m.through_ms - ?4 FROM automation_schedule_marks m \
           WHERE m.workspace_id = ?1 AND m.automation_id = ?2) \
       AND claim_id NOT IN ( \
           SELECT claim_id FROM automation_claims \
           WHERE workspace_id = ?1 AND automation_id = ?2 \
           ORDER BY created_at_ms DESC, claim_id DESC LIMIT ?3)";

/// Clear the facts of an automation's settled moment and message claims past
/// its history. The terms before `claim_id` match
/// `idx_automation_claims_settled_facts`, so the update reads only claims
/// that still carry facts.
pub(crate) const CLEAR_SETTLED_CLAIM_FACTS_SQL: &str = "UPDATE automation_claims \
     SET change_fields_json = '[]', change_fields_omitted = 0, message_json = NULL \
     WHERE workspace_id = ?1 AND automation_id = ?2 AND state = 'done' AND run = 1 \
       AND (trigger_moment_order IS NOT NULL OR change_kind = 'message') \
       AND (change_fields_json <> '[]' OR message_json IS NOT NULL) \
       AND claim_id NOT IN ( \
           SELECT claim_id FROM automation_claims \
           WHERE workspace_id = ?1 AND automation_id = ?2 \
           ORDER BY created_at_ms DESC, claim_id DESC LIMIT ?3)";

/// The startup reaper. A running claim whose process died — running, and not
/// touched since `stale_before_ms` — is requeued to pending while attempts
/// remain, else terminally failed with [`AUTOMATION_RECLAIM_EXHAUSTED`], the
/// chat ledger's rule. The age bound protects a claim a still-alive desktop
/// process is running across a daemon rebind. Returns every transitioned
/// claim. Deferred startup recovery supplies its observed attempts; a later
/// attempt with the same claim ID must remain with its current executor.
pub(crate) fn reclaim_running_automations_in_tx(
    conn: &Connection,
    workspace_id: &str,
    attempts: Option<&[AutomationClaimAttempt]>,
    max_attempts: i64,
    stale_before_ms: i64,
    now_ms: i64,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {CLAIM_COLUMNS} FROM automation_claims \
             WHERE workspace_id = ?1 AND state = 'running' AND updated_at_ms <= ?2 \
             ORDER BY created_at_ms, claim_id"
        ))
        .map_err(DomainError::sql_corrupt)?;
    let stale: Vec<AutomationClaim> = statement
        .query_map(params![workspace_id, stale_before_ms], claim_from_row)
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(DomainError::sql_corrupt)?
        .into_iter()
        .collect::<Result<_, _>>()?;
    let attempts: Option<HashSet<(&str, i64, i64)>> = attempts.map(|attempts| {
        attempts
            .iter()
            .map(|attempt| {
                (
                    attempt.claim_id.as_str(),
                    attempt.attempts,
                    attempt.started_at_ms,
                )
            })
            .collect()
    });
    let mut reclaimed = Vec::with_capacity(stale.len());
    for claim in stale {
        if attempts.as_ref().is_some_and(|attempts| {
            !attempts.contains(&(claim.claim_id.as_str(), claim.attempts, claim.updated_at_ms))
        }) {
            continue;
        }
        let exhausted = claim.attempts >= max_attempts;
        let rows = conn
            .execute(
                "UPDATE automation_claims \
                 SET state = ?3, error = ?4, updated_at_ms = ?5 \
                 WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'running'",
                params![
                    workspace_id,
                    claim.claim_id,
                    if exhausted { "failed" } else { "pending" },
                    if exhausted {
                        Some(AUTOMATION_RECLAIM_EXHAUSTED)
                    } else {
                        None
                    },
                    now_ms,
                ],
            )
            .map_err(DomainError::sql_persist)?;
        if rows != 1 {
            return Err(DomainError::StateCorrupt {
                reason: "automation claim vanished mid-reclaim under the single writer",
            });
        }
        let transitioned =
            claim_by_id(conn, workspace_id, &claim.claim_id)?.ok_or(DomainError::StateCorrupt {
                reason: "reclaimed automation claim not found after update",
            })?;
        reclaimed.push(transitioned);
    }
    Ok(reclaimed)
}

/// Store-level wrappers: one `BEGIN IMMEDIATE` transaction each, for the
/// runtime actor's command arms.
pub fn subscribe_automation(
    store: &mut EngineStore,
    workspace_id: &str,
    subscription: &AutomationSubscription,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<bool, DomainError> {
    committed(store.write_with(faults, |tx| {
        subscribe_automation_in_tx(tx, workspace_id, subscription, now_ms)
    })?)
}

pub fn subscribe_automation_group(
    store: &mut EngineStore,
    workspace_id: &str,
    subscription: &AutomationGroupSubscription,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<bool, DomainError> {
    committed(store.write_with(faults, |tx| {
        subscribe_automation_group_in_tx(tx, workspace_id, subscription, now_ms)
    })?)
}

pub fn unsubscribe_automation_group(
    store: &mut EngineStore,
    workspace_id: &str,
    automation_id: &str,
    channel_id: &str,
    faults: &dyn FaultInjector,
) -> Result<bool, DomainError> {
    committed(store.write_with(faults, |tx| {
        unsubscribe_automation_group_in_tx(tx, workspace_id, automation_id, channel_id)
    })?)
}

/// Remove every Group subscription in the workspace, in one transaction:
/// once it commits, no message this computer stores claims until a Group
/// subscription is added again. The desktop calls it before it hands the
/// workspace's automations to another computer, so a subscription it lost
/// track of goes too. Returns how many it removed.
pub fn unsubscribe_automation_groups(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<usize, DomainError> {
    committed(store.write_with(faults, |tx| {
        tx.execute(
            "DELETE FROM automation_group_subscriptions WHERE workspace_id = ?1",
            params![workspace_id],
        )
        .map_err(DomainError::sql_persist)
    })?)
}

pub fn unsubscribe_automation(
    store: &mut EngineStore,
    workspace_id: &str,
    automation_id: &str,
    prefix: &str,
    faults: &dyn FaultInjector,
) -> Result<bool, DomainError> {
    committed(store.write_with(faults, |tx| {
        unsubscribe_automation_in_tx(tx, workspace_id, automation_id, prefix)
    })?)
}

pub fn claim_next_pending_automation(
    store: &mut EngineStore,
    workspace_id: &str,
    automation_id_prefix: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Option<(AutomationClaim, AutomationFieldFacts)>, DomainError> {
    committed(store.write_with(faults, |tx| {
        claim_next_pending_automation_in_tx(tx, workspace_id, automation_id_prefix, now_ms)
    })?)
}

pub fn retry_automation_claim(
    store: &mut EngineStore,
    workspace_id: &str,
    claim_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationRetry, DomainError> {
    committed(store.write_with(faults, |tx| {
        retry_automation_claim_in_tx(tx, workspace_id, claim_id, now_ms)
    })?)
}

pub fn release_automation_claim(
    store: &mut EngineStore,
    workspace_id: &str,
    claim_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationClaim, DomainError> {
    committed(store.write_with(faults, |tx| {
        release_automation_claim_in_tx(tx, workspace_id, claim_id, now_ms)
    })?)
}

pub fn list_automation_claims(
    store: &EngineStore,
    workspace_id: &str,
    automation_id: &str,
) -> Result<Vec<AutomationClaim>, DomainError> {
    store.read_with(|conn| list_automation_claims_in_tx(conn, workspace_id, automation_id))
}

pub fn press_automation(
    store: &mut EngineStore,
    workspace_id: &str,
    press: &AutomationPress,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationPressed, DomainError> {
    committed(store.write_with(faults, |tx| {
        press_automation_in_tx(tx, workspace_id, press, now_ms)
    })?)
}

pub fn claim_automation_schedule(
    store: &mut EngineStore,
    workspace_id: &str,
    schedule: &AutomationScheduleClaim,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationScheduleClaimed, DomainError> {
    committed(store.write_with(faults, |tx| {
        claim_automation_schedule_in_tx(tx, workspace_id, schedule, now_ms)
    })?)
}

pub fn claim_automation_run_now(
    store: &mut EngineStore,
    workspace_id: &str,
    automation_id: &str,
    notice_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationRunNow, DomainError> {
    committed(store.write_with(faults, |tx| {
        claim_automation_run_now_in_tx(tx, workspace_id, automation_id, notice_id, now_ms)
    })?)
}

pub fn list_automation_schedule_marks(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<AutomationScheduleMark>, DomainError> {
    store.read_with(|conn| list_automation_schedule_marks_in_tx(conn, workspace_id))
}

pub fn settle_automation_claim(
    store: &mut EngineStore,
    workspace_id: &str,
    claim_id: &str,
    settle: &AutomationSettle,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationClaim, DomainError> {
    committed(store.write_with(faults, |tx| {
        settle_automation_claim_in_tx(tx, workspace_id, claim_id, settle, now_ms)
    })?)
}

pub fn list_automation_failures(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<AutomationFailure>, DomainError> {
    store.read_with(|conn| list_automation_failures_in_tx(conn, workspace_id))
}

pub fn reclaim_running_automations(
    store: &mut EngineStore,
    workspace_id: &str,
    attempts: Option<&[AutomationClaimAttempt]>,
    max_attempts: i64,
    stale_before_ms: i64,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Vec<AutomationClaim>, DomainError> {
    committed(store.write_with(faults, |tx| {
        reclaim_running_automations_in_tx(
            tx,
            workspace_id,
            attempts,
            max_attempts,
            stale_before_ms,
            now_ms,
        )
    })?)
}

#[cfg(test)]
mod tests {
    use super::{CLEAR_SETTLED_CLAIM_FACTS_SQL, PRUNE_SETTLED_RECORD_CLAIMS_SQL};
    use dohc_engine_storage::EngineStore;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};

    /// Message claims keep their key rows forever, so settle's pruning must
    /// read only the claims it can change, through the partial indexes.
    #[test]
    fn settle_pruning_reads_through_the_partial_indexes() {
        let scratch = ScratchDir::new().expect("scratch");
        let store = EngineStore::open(&engine_db_path(&scratch).expect("db"), 1).expect("store");
        for (sql, index) in [
            (
                PRUNE_SETTLED_RECORD_CLAIMS_SQL,
                "idx_automation_claims_prunable",
            ),
            (
                CLEAR_SETTLED_CLAIM_FACTS_SQL,
                "idx_automation_claims_settled_facts",
            ),
        ] {
            let plan: Vec<String> = store
                .read_with(|conn| {
                    let mut statement = conn
                        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                        .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
                    let rows = statement
                        .query_map(rusqlite::params!["ws", "collection:Trip#all", 100], |row| {
                            row.get::<_, String>(3)
                        })
                        .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(dohc_engine_storage::StorageError::corrupt_public)
                })
                .expect("query plan");
            assert!(
                plan.iter().any(
                    |step| step.starts_with("SEARCH automation_claims USING INDEX ")
                        && step.contains(index)
                ),
                "{index}: {plan:?}"
            );
        }
    }
}
