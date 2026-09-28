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
    CollectionRecordLifecycle, CollectionRecordLifecycleKind, SharedChangeAuthor, field_fact_value,
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
/// `collection:<collection id>#<automation id>`, where the Collection id is
/// its schema file's object id or its dataset's id, so a Collection keeps
/// its automations' ids when it moves. The Collection executor
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

/// How far back a host keeps what it decided about Group messages, and so
/// how far back a handover carries it. A watch or a release starts every
/// Group subscription no earlier than this before it: a message that first
/// reaches a host longer than this after it was posted can claim nothing
/// there.
pub const AUTOMATION_GROUP_COVERAGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The most decided messages a host keeps, and so the most one handover
/// carries. Past it, every Group subscription starts after the newest one
/// left out, and claims nothing posted before that.
pub const MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES: usize = 2_000;

/// How far past this computer's clock a Group message may be dated and
/// still claim when it arrives. One dated later decides nothing then, so a
/// forged date cannot hold the coverage; a later watch that starts its
/// automation here can still claim it.
pub const AUTOMATION_GROUP_FUTURE_MS: i64 = 60 * 60 * 1000;

/// The most Group subscriptions one computer watches in a workspace.
pub const MAX_AUTOMATION_GROUP_SUBSCRIPTIONS: usize = 256;

/// The most automations one handover names: those watched, and those a
/// handover named that this computer could not watch yet.
pub const MAX_AUTOMATION_GROUP_HANDOVER_AUTOMATIONS: usize = 2 * MAX_AUTOMATION_GROUP_SUBSCRIPTIONS;

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
    /// `collection:<collection id>#<automation id>`.
    pub automation_id: String,
    /// The Group's channel id on this computer.
    pub channel_id: String,
    pub starts_with: Option<String>,
}

/// What the next host needs so each Group message claims exactly once across
/// a handover (ADR 0012). Messages posted before `floor_ms` claim nothing
/// there, whatever an automation's start. For each automation this computer
/// watched: the time its messages start, and each message some host already
/// decided for it, claimed or skipped as the automation's own post, since
/// the floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupHandover {
    pub floor_ms: i64,
    pub automations: Vec<AutomationGroupHandoverAutomation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupHandoverAutomation {
    pub automation_id: String,
    pub since_ms: i64,
    /// Each decided message's id and the time it was posted.
    pub decided: Vec<(String, i64)>,
}

/// The Group subscriptions a computer that runs Group automations watches
/// now, all of them, at the automation host generation it runs at: 0 for a
/// workspace that never synced. `relay` is what the relay held at that
/// generation, or `None` when the caller has not asked it: a watch at a
/// generation this computer has not watched at then changes nothing and
/// asks for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupWatch {
    pub generation: i64,
    pub subscriptions: Vec<AutomationGroupSubscription>,
    pub relay: Option<AutomationGroupRelayRecord>,
}

/// The last release or take over the relay recorded: the host generation
/// it started, 0 for none, and the handover when a release left it for this
/// computer. Newer than the generation this computer last watched at, it
/// means another computer may have run since: a handover left here is
/// taken, and without one, what this computer froze starts again from now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupRelayRecord {
    pub generation: i64,
    pub handover: Option<AutomationGroupHandover>,
}

/// What a release answers: the handover, and the host generation this
/// computer last watched at. When the relay recorded a release or take over
/// after that, this computer ran nothing since, and its handover is stale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupRelease {
    pub watched_generation: i64,
    pub handover: AutomationGroupHandover,
}

/// What a watch did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationGroupWatched {
    /// The generation is new and no handover came: nothing changed.
    pub needs_handover: bool,
    /// Claims for messages stored before the subscription started here.
    pub claims: Vec<AutomationClaim>,
}

/// When Group messages last started nothing here for a reason a person can
/// act on, by this computer's clock; `None` when that never happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AutomationGroupSkips {
    /// A message was dated more than [`AUTOMATION_GROUP_FUTURE_MS`] past
    /// this computer's clock.
    pub ahead_at_ms: Option<i64>,
    /// A message posted after its automation started here arrived after the
    /// coverage floor passed it.
    pub late_at_ms: Option<i64>,
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
    /// another computer sent with the message. An agent's message written on
    /// this computer during an agent run carries that run's depth.
    pub chain_depth: Option<u32>,
}

/// The change a claim runs for and who made it, named as record history
/// names them: the author origin, and the declared actor kind and the
/// person it acted for. Each is `None` when the write did not declare it.
/// `on_behalf_of` is that person: who pressed a button, who wrote a message,
/// or who made a record change or had an agent or automation make it. A
/// record change the relay accepted from a person the owner shared with
/// names that person, and one from an Edit share link names no one.
/// `shared_author` is the person the owner shared with, or the Edit share
/// link, the relay accepted the change from. `live_cursor` is the relay's
/// live journal cursor of the frame a live-shared record's change came in,
/// so the relay can tell when a settlement has carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationChange {
    pub kind: AutomationChangeKind,
    pub author_origin_id: Option<String>,
    pub actor_kind: Option<ChangeActorKind>,
    pub on_behalf_of: Option<String>,
    pub shared_author: Option<SharedChangeAuthor>,
    pub live_cursor: Option<i64>,
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
    /// The Collection the changed record was in. A claim that names its
    /// automation, a press, a due time, a Run now, or a Group message, has
    /// none: the executor finds the Collection from the automation id.
    pub collection_path: Option<String>,
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
     trigger_moment_order, trigger_key, change_author_json, change_live_cursor";

fn claim_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<AutomationClaim, DomainError>> {
    let claim_id: String = row.get(0)?;
    let automation_id: String = row.get(1)?;
    let trigger_origin_id: Option<String> = row.get(2)?;
    let trigger_origin_seq: Option<i64> = row.get(3)?;
    let trigger_history_id: Option<i64> = row.get(4)?;
    let record_id: Option<String> = row.get(5)?;
    // A claim with no Collection path stores an empty one.
    let collection_path: String = row.get(6)?;
    let collection_path = (!collection_path.is_empty()).then_some(collection_path);
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
    let change_author_json: Option<String> = row.get(20)?;
    let live_cursor: Option<i64> = row.get(21)?;
    let claim = (|| {
        let shared_author = change_author_json
            .map(|json| {
                serde_json::from_str::<SharedChangeAuthor>(&json)
                    .ok()
                    .filter(SharedChangeAuthor::is_valid)
                    .ok_or(DomainError::StateCorrupt {
                        reason: "automation claim shared author is not a known author",
                    })
            })
            .transpose()?;
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
                shared_author,
                live_cursor,
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

/// Whether an id names a Collection automation,
/// `collection:<collection id>#<automation id>`. A Collection id is an
/// object id or a dataset id: letters, digits, `-`, and `_`, never a path.
pub fn is_collection_automation_id(automation_id: &str) -> bool {
    automation_id
        .strip_prefix(AUTOMATION_ID_NAMESPACE)
        .and_then(|rest| rest.split_once('#'))
        .is_some_and(|(collection, local)| {
            !collection.is_empty()
                && collection
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                && !local.is_empty()
        })
        && automation_id.len() <= MAX_IDENTIFIER_BYTES
        && automation_id.trim() == automation_id
        && !automation_id.chars().any(char::is_control)
}

/// A Group subscription's channel id, once it names a Collection automation,
/// a Group on this computer, and a bounded starting text that starts with
/// text, not space.
fn group_subscription_channel(
    conn: &Connection,
    workspace_id: &str,
    subscription: &AutomationGroupSubscription,
) -> Result<String, DomainError> {
    if !is_collection_automation_id(&subscription.automation_id) {
        return Err(DomainError::InvalidInput {
            reason: "A Group subscription belongs to a Collection automation, collection:<collection id>#<id>.",
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
    Ok(channel_id)
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

/// One Group subscription as a claim reads it. Messages posted before
/// `since_ms` claim nothing. One posted since, but before `floor_ms`, the
/// oldest time the coverage still holds, arrived too late to claim.
struct GroupWatch<'a> {
    automation_id: &'a str,
    starts_with: Option<&'a str>,
    channel_id: &'a str,
    since_ms: i64,
    floor_ms: i64,
}

/// What deciding one message for one subscription came to.
enum GroupDecision {
    /// Not for this subscription, or decided before.
    Passed,
    /// Posted after the subscription started, but before the coverage floor.
    Late,
    /// Dated more than [`AUTOMATION_GROUP_FUTURE_MS`] past this computer's clock.
    Ahead,
    /// Recorded now, with the claims it took.
    Decided(Vec<AutomationClaim>),
}

/// Claim a message this computer is storing, in the transaction that stores
/// it, for every running Group subscription on its thread's Group. Only a
/// Group, a channel of kind `channel`, has subscriptions that claim; a DM, the
/// agent channel, and a file's thread never do. A frozen subscription, on a
/// computer that handed its automations over, claims nothing. Returns only
/// the claims this call inserted.
pub fn claim_group_message_in_tx(
    conn: &Connection,
    workspace_id: &str,
    message: &AutomationGroupMessage<'_>,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT s.automation_id, s.starts_with, t.channel_id, t.lane, s.created_at_ms \
             FROM chat_threads t \
             JOIN chat_channels c \
               ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id \
             JOIN automation_group_subscriptions s \
               ON s.workspace_id = t.workspace_id AND s.channel_id = t.channel_id \
             WHERE t.workspace_id = ?1 AND t.thread_id = ?2 AND c.kind = 'channel' \
               AND s.frozen = 0 \
             ORDER BY s.automation_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let subscriptions: Vec<(String, Option<String>, String, String, i64)> = statement
        .query_map(params![workspace_id, message.thread_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    if subscriptions.is_empty() {
        return Ok(Vec::new());
    }
    let floor_ms = group_state(conn, workspace_id)?.floor_ms;
    let mut inserted = Vec::new();
    let (mut decided, mut late, mut ahead) = (false, false, false);
    for (automation_id, starts_with, channel_id, lane, since_ms) in &subscriptions {
        let watch = GroupWatch {
            automation_id,
            starts_with: starts_with.as_deref(),
            channel_id,
            since_ms: *since_ms,
            floor_ms,
        };
        match decide_group_message(conn, workspace_id, &watch, lane, message)? {
            GroupDecision::Passed => {}
            GroupDecision::Late => late = true,
            GroupDecision::Ahead => ahead = true,
            GroupDecision::Decided(claims) => {
                decided = true;
                inserted.extend(claims);
            }
        }
    }
    record_group_skips(conn, workspace_id, ahead, late)?;
    // Once the message is decided for every subscription, so no decision
    // above met a floor another one moved.
    if decided {
        maintain_group_coverage(conn, workspace_id, i64::MIN)?;
    }
    Ok(inserted)
}

/// Notes, by this computer's clock, that a Group message started nothing
/// for a reason a person can act on, so the desktop can say so once.
fn record_group_skips(
    conn: &Connection,
    workspace_id: &str,
    ahead: bool,
    late: bool,
) -> Result<(), DomainError> {
    if !ahead && !late {
        return Ok(());
    }
    let now_ms = clock_ms();
    conn.prepare_cached(
        "INSERT INTO automation_group_state \
           (workspace_id, ahead_skipped_at_ms, late_skipped_at_ms) VALUES (?1, ?2, ?3) \
         ON CONFLICT(workspace_id) DO UPDATE SET \
           ahead_skipped_at_ms = COALESCE(excluded.ahead_skipped_at_ms, ahead_skipped_at_ms), \
           late_skipped_at_ms = COALESCE(excluded.late_skipped_at_ms, late_skipped_at_ms)",
    )
    .map_err(DomainError::sql_corrupt)?
    .execute(params![
        workspace_id,
        ahead.then_some(now_ms),
        late.then_some(now_ms)
    ])
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Decide one message for one watching automation, once on every host that
/// ever runs it: record the decision in the coverage, then claim the message,
/// unless the automation wrote it. A message posted before the subscription
/// starts, or whose text, after its leading whitespace, does not begin with
/// the starting text, is not for it. One posted before the coverage floor,
/// or dated more than [`AUTOMATION_GROUP_FUTURE_MS`] past this computer's
/// clock, is not decided either, and the answer says which. A message a host
/// decided before, here or on a computer that handed over, claims nothing. A
/// message at the chain depth cap records a failed `chain-stopped` claim
/// instead. The caller keeps the coverage within its bounds once it has
/// decided everything in hand, so no decision meets a floor that moved
/// under it.
fn decide_group_message(
    conn: &Connection,
    workspace_id: &str,
    watch: &GroupWatch<'_>,
    lane: &str,
    message: &AutomationGroupMessage<'_>,
) -> Result<GroupDecision, DomainError> {
    let text = message.body.trim_start_matches(is_js_trim_ws);
    if message.created_at_ms < watch.since_ms
        || watch
            .starts_with
            .is_some_and(|prefix| !text.starts_with(prefix))
    {
        return Ok(GroupDecision::Passed);
    }
    if message.created_at_ms < watch.floor_ms {
        return Ok(GroupDecision::Late);
    }
    if message.created_at_ms > clock_ms().saturating_add(AUTOMATION_GROUP_FUTURE_MS) {
        return Ok(GroupDecision::Ahead);
    }
    let decided_now = conn
        .execute(
            "INSERT OR IGNORE INTO automation_group_coverage \
             (workspace_id, automation_id, message_id, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![
                workspace_id,
                watch.automation_id,
                message.message_id,
                message.created_at_ms
            ],
        )
        .map_err(DomainError::sql_persist)?
        == 1;
    if !decided_now {
        return Ok(GroupDecision::Passed);
    }
    if message.automation_id == Some(watch.automation_id) {
        return Ok(GroupDecision::Decided(Vec::new()));
    }
    // An automation message claims at its depth, kept within 1 and the cap, so
    // a chain stops at the cap across computers. A forged high depth only
    // stops a chain early; a missing one counts as 1. An agent's message
    // claims at its run's depth, so an agent an automation woke cannot start
    // the chain over by posting.
    let depth = match message.author_kind {
        "automation" => message
            .chain_depth
            .unwrap_or(1)
            .clamp(1, AUTOMATION_CHAIN_DEPTH_CAP),
        "agent" => message
            .chain_depth
            .unwrap_or(0)
            .min(AUTOMATION_CHAIN_DEPTH_CAP),
        _ => 0,
    };
    let chain_stopped = depth >= AUTOMATION_CHAIN_DEPTH_CAP;
    let claimed = ClaimedChange {
        trigger: AutomationTrigger::Key {
            key: format!("message:{}", message.message_id),
        },
        record_id: None,
        collection_path: None,
        depth,
        change: AutomationChange {
            kind: AutomationChangeKind::Message,
            author_origin_id: message.automation_id.map(str::to_owned),
            actor_kind: ChangeActorKind::parse(message.author_kind),
            on_behalf_of: message.author_user_id.map(str::to_owned),
            shared_author: None,
            live_cursor: None,
        },
        // A stopped chain never runs, so its claim keeps no message.
        fields: AutomationFieldFacts {
            message: (!chain_stopped).then(|| claim_message(message, watch.channel_id, lane)),
            ..AutomationFieldFacts::default()
        },
        chain_stopped,
    };
    insert_claims(
        conn,
        workspace_id,
        &[watch.automation_id],
        &claimed,
        message.created_at_ms,
    )
    .map(GroupDecision::Decided)
}

/// A Group subscription row whose automation a handover named but this
/// computer could not watch yet, as when its Group or its automation had
/// not synced here. It keeps that automation's start, so the automation
/// starts there once this computer watches it. It claims nothing.
const PENDING_GROUP: &str = "";

/// Stop every Group subscription here from claiming, and answer what the
/// next host needs, in one transaction (ADR 0012). The subscriptions stay,
/// frozen, so a release repeated after a lost answer answers them again.
fn release_automation_groups_in_tx(
    conn: &Connection,
    workspace_id: &str,
    now_ms: i64,
) -> Result<AutomationGroupRelease, DomainError> {
    let floor_ms = maintain_group_coverage(
        conn,
        workspace_id,
        now_ms.saturating_sub(AUTOMATION_GROUP_COVERAGE_MS),
    )?;
    conn.execute(
        "UPDATE automation_group_subscriptions SET frozen = 1 \
         WHERE workspace_id = ?1 AND frozen = 0",
        params![workspace_id],
    )
    .map_err(DomainError::sql_persist)?;
    let mut automations: Vec<AutomationGroupHandoverAutomation> = conn
        .prepare_cached(
            "SELECT automation_id, MIN(created_at_ms) FROM automation_group_subscriptions \
             WHERE workspace_id = ?1 GROUP BY automation_id ORDER BY automation_id LIMIT ?2",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_map(
            params![
                workspace_id,
                MAX_AUTOMATION_GROUP_HANDOVER_AUTOMATIONS as i64
            ],
            |row| {
                Ok(AutomationGroupHandoverAutomation {
                    automation_id: row.get(0)?,
                    since_ms: row.get(1)?,
                    decided: Vec::new(),
                })
            },
        )
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    // Maintenance left every decision within the bounds, so each one goes.
    let mut decided = conn
        .prepare_cached(
            "SELECT automation_id, message_id, created_at_ms FROM automation_group_coverage \
             WHERE workspace_id = ?1 ORDER BY automation_id, message_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut rows = decided
        .query(params![workspace_id])
        .map_err(DomainError::sql_corrupt)?;
    while let Some(row) = rows.next().map_err(DomainError::sql_corrupt)? {
        let automation_id: String = row.get(0).map_err(DomainError::sql_corrupt)?;
        if let Ok(index) = automations
            .binary_search_by(|automation| automation.automation_id.as_str().cmp(&automation_id))
        {
            automations[index].decided.push((
                row.get(1).map_err(DomainError::sql_corrupt)?,
                row.get(2).map_err(DomainError::sql_corrupt)?,
            ));
        }
    }
    drop(rows);
    Ok(AutomationGroupRelease {
        watched_generation: group_state(conn, workspace_id)?.generation,
        handover: AutomationGroupHandover {
            floor_ms,
            automations,
        },
    })
}

/// This computer's Group automations in one workspace: the host generation
/// it last watched its Group subscriptions at, 0 before the first, when it
/// last took a handover, and the coverage floor, `i64::MIN` before any.
struct GroupState {
    generation: i64,
    imported_at_ms: i64,
    floor_ms: i64,
}

fn group_state(conn: &Connection, workspace_id: &str) -> Result<GroupState, DomainError> {
    Ok(conn
        .prepare_cached(
            "SELECT generation, imported_at_ms, floor_ms FROM automation_group_state \
             WHERE workspace_id = ?1",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_row(params![workspace_id], |row| {
            Ok(GroupState {
                generation: row.get(0)?,
                imported_at_ms: row.get(1)?,
                floor_ms: row.get::<_, Option<i64>>(2)?.unwrap_or(i64::MIN),
            })
        })
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .unwrap_or(GroupState {
            generation: 0,
            imported_at_ms: 0,
            floor_ms: i64::MIN,
        }))
}

/// This computer's clock, where no caller passes the time: how far ahead a
/// stored message may be dated, and when a Group message started nothing.
fn clock_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Keeps what this computer decided about Group messages within its bounds,
/// and moves the coverage floor, before which no message claims, past every
/// decision it lets go, so the coverage always holds each decision a
/// subscription could meet again. The floor only rises. The bounds are the
/// newest [`MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES`] decisions, however they
/// are dated, and none posted before `window_start`. A pending row whose
/// handover was taken before `window_start` goes too. Answers the floor.
/// Storing a message that decided anything runs it without a window, after
/// every subscription decided; a watch and a release run it with one.
fn maintain_group_coverage(
    conn: &Connection,
    workspace_id: &str,
    window_start: i64,
) -> Result<i64, DomainError> {
    let newest_left_out: Option<i64> = conn
        .prepare_cached(
            "SELECT created_at_ms FROM automation_group_coverage WHERE workspace_id = ?1 \
             ORDER BY created_at_ms DESC LIMIT 1 OFFSET ?2",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_row(
            params![workspace_id, MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let stored_floor_ms = group_state(conn, workspace_id)?.floor_ms;
    let floor_ms = newest_left_out
        .map_or(window_start, |left_out| {
            window_start.max(left_out.saturating_add(1))
        })
        .max(stored_floor_ms);
    if floor_ms > stored_floor_ms {
        raise_group_floor(conn, workspace_id, floor_ms)?;
    }
    conn.prepare_cached(
        "DELETE FROM automation_group_subscriptions \
         WHERE workspace_id = ?1 AND channel_id = ?2 AND EXISTS \
           (SELECT 1 FROM automation_group_state \
            WHERE workspace_id = ?1 AND imported_at_ms < ?3)",
    )
    .map_err(DomainError::sql_corrupt)?
    .execute(params![workspace_id, PENDING_GROUP, window_start])
    .map_err(DomainError::sql_persist)?;
    conn.prepare_cached(
        "DELETE FROM automation_group_coverage WHERE workspace_id = ?1 AND created_at_ms < ?2",
    )
    .map_err(DomainError::sql_corrupt)?
    .execute(params![workspace_id, floor_ms])
    .map_err(DomainError::sql_persist)?;
    Ok(floor_ms)
}

/// Raises the workspace's coverage floor to `floor_ms`, never lowers it.
fn raise_group_floor(
    conn: &Connection,
    workspace_id: &str,
    floor_ms: i64,
) -> Result<(), DomainError> {
    conn.prepare_cached(
        "INSERT INTO automation_group_state (workspace_id, floor_ms) VALUES (?1, ?2) \
         ON CONFLICT(workspace_id) DO UPDATE SET \
           floor_ms = MAX(COALESCE(floor_ms, excluded.floor_ms), excluded.floor_ms)",
    )
    .map_err(DomainError::sql_corrupt)?
    .execute(params![workspace_id, floor_ms])
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Set the Group subscriptions this computer watches, all of them, in one
/// transaction. At a host generation it has not watched at yet, it first
/// reads what the relay recorded. A handover left here is taken: every
/// message the last host decided claims nothing here, and each automation
/// starts where it started there. An automation the handover names that
/// this computer cannot watch yet keeps that start until it can. A
/// subscription that was not running here claims, in the same transaction,
/// each stored message it would have claimed. One still running keeps its
/// start, so it claims nothing twice.
fn watch_automation_groups_in_tx(
    conn: &Connection,
    workspace_id: &str,
    watch: &AutomationGroupWatch,
    now_ms: i64,
) -> Result<AutomationGroupWatched, DomainError> {
    if !(0..=MAX_SAFE_GENERATION).contains(&watch.generation)
        || watch
            .relay
            .as_ref()
            .is_some_and(|relay| !(0..=MAX_SAFE_GENERATION).contains(&relay.generation))
    {
        return Err(DomainError::InvalidInput {
            reason: "An automation host generation is a whole number from 0.",
        });
    }
    if watch.subscriptions.len() > MAX_AUTOMATION_GROUP_SUBSCRIPTIONS {
        return Err(DomainError::InvalidInput {
            reason: "Too many Group subscriptions for one workspace.",
        });
    }
    // Every subscription is checked before anything changes.
    let mut automations = HashSet::new();
    let mut channels = Vec::with_capacity(watch.subscriptions.len());
    for subscription in &watch.subscriptions {
        if !automations.insert(subscription.automation_id.as_str()) {
            return Err(DomainError::InvalidInput {
                reason: "An automation watches one Group.",
            });
        }
        channels.push(group_subscription_channel(
            conn,
            workspace_id,
            subscription,
        )?);
    }
    let watched = group_state(conn, workspace_id)?;
    // What this watch does with the rows it finds: take a new handover, keep
    // them as they are because no other computer ran since this one last
    // watched, or else start what was frozen again from now.
    let mut import: Option<&AutomationGroupHandover> = None;
    let mut resume = true;
    if watch.generation != watched.generation {
        let Some(relay) = &watch.relay else {
            return Ok(AutomationGroupWatched {
                needs_handover: true,
                claims: Vec::new(),
            });
        };
        // A generation below the last one watched here means the relay lost
        // what it recorded, so nothing says who ran since.
        if watch.generation < watched.generation {
            resume = false;
        } else if relay.generation > watched.generation {
            match &relay.handover {
                Some(handover) => {
                    validate_group_handover(handover)?;
                    import = Some(handover);
                }
                None => resume = false,
            }
        }
        conn.execute(
            "INSERT INTO automation_group_state (workspace_id, generation, imported_at_ms) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(workspace_id) DO UPDATE SET \
               generation = excluded.generation, imported_at_ms = excluded.imported_at_ms",
            params![
                workspace_id,
                watch.generation,
                if import.is_some() {
                    now_ms
                } else {
                    watched.imported_at_ms
                }
            ],
        )
        .map_err(DomainError::sql_persist)?;
    }
    if let Some(handover) = import {
        raise_group_floor(conn, workspace_id, handover.floor_ms)?;
        let mut insert = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO automation_group_coverage \
                 (workspace_id, automation_id, message_id, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(DomainError::sql_corrupt)?;
        for automation in &handover.automations {
            for (message_id, created_at_ms) in &automation.decided {
                insert
                    .execute(params![
                        workspace_id,
                        automation.automation_id,
                        message_id,
                        created_at_ms
                    ])
                    .map_err(DomainError::sql_persist)?;
            }
        }
    }
    let floor_ms = maintain_group_coverage(
        conn,
        workspace_id,
        now_ms.saturating_sub(AUTOMATION_GROUP_COVERAGE_MS),
    )?;
    // The rows as they stand: running here, frozen here, or pending from an
    // earlier handover, each with its start.
    let rows: Vec<(String, String, i64, bool)> = conn
        .prepare_cached(
            "SELECT automation_id, channel_id, created_at_ms, frozen \
             FROM automation_group_subscriptions WHERE workspace_id = ?1",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_map(params![workspace_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    conn.execute(
        "DELETE FROM automation_group_subscriptions WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map_err(DomainError::sql_persist)?;
    // A handover taken now replaces what was frozen and pending here. With no
    // new handover, a frozen row starts where it was, and pending rows stay;
    // when another computer may have run, neither does.
    let handed_over: Vec<(&str, i64)> = import.map_or_else(Vec::new, |handover| {
        handover
            .automations
            .iter()
            .map(|automation| (automation.automation_id.as_str(), automation.since_ms))
            .collect()
    });
    let kept: Vec<(&str, &str, i64)> = if import.is_none() && resume {
        rows.iter()
            .filter(|(_, _, _, frozen)| *frozen)
            .map(|(automation_id, channel_id, since_ms, _)| {
                (automation_id.as_str(), channel_id.as_str(), *since_ms)
            })
            .collect()
    } else {
        Vec::new()
    };
    let handed_start = |automation_id: &str| {
        handed_over
            .iter()
            .find(|(handed, _)| *handed == automation_id)
            .map(|(_, since_ms)| *since_ms)
    };
    let kept_start = |automation_id: &str, channel_id: &str| {
        kept.iter()
            .find(|(frozen, channel, _)| {
                *frozen == automation_id && (*channel == channel_id || *channel == PENDING_GROUP)
            })
            .map(|(_, _, since_ms)| *since_ms)
    };
    let mut claims = Vec::new();
    for (subscription, channel_id) in watch.subscriptions.iter().zip(&channels) {
        let still_running = rows
            .iter()
            .find(|(automation_id, channel, _, frozen)| {
                !*frozen && *automation_id == subscription.automation_id && channel == channel_id
            })
            .map(|(_, _, since_ms, _)| *since_ms);
        let start_ms = handed_start(&subscription.automation_id)
            .or(still_running)
            .or_else(|| kept_start(&subscription.automation_id, channel_id))
            .unwrap_or(now_ms);
        insert_group_row(
            conn,
            workspace_id,
            subscription,
            channel_id,
            start_ms,
            false,
        )?;
        if still_running.is_none() || handed_start(&subscription.automation_id).is_some() {
            // A replay reads from the floor: below it, a stored message may
            // have been decided and trimmed, so it is neither claimed nor
            // reported late.
            let watch = GroupWatch {
                automation_id: &subscription.automation_id,
                starts_with: subscription.starts_with.as_deref(),
                channel_id,
                since_ms: start_ms.max(floor_ms),
                floor_ms,
            };
            claims.extend(claim_stored_group_messages(conn, workspace_id, &watch)?);
        }
    }
    let pending: Vec<(&str, i64)> = if import.is_some() {
        handed_over.clone()
    } else {
        kept.iter()
            .filter(|(_, channel_id, _)| *channel_id == PENDING_GROUP)
            .map(|(automation_id, _, since_ms)| (*automation_id, *since_ms))
            .collect()
    };
    // What a handover named and this computer cannot watch yet keeps its start.
    let room = MAX_AUTOMATION_GROUP_HANDOVER_AUTOMATIONS.saturating_sub(watch.subscriptions.len());
    for (automation_id, since_ms) in pending
        .iter()
        .filter(|(automation_id, _)| !automations.contains(automation_id))
        .take(room)
    {
        let pending_row = AutomationGroupSubscription {
            automation_id: (*automation_id).to_owned(),
            channel_id: PENDING_GROUP.to_owned(),
            starts_with: None,
        };
        insert_group_row(
            conn,
            workspace_id,
            &pending_row,
            PENDING_GROUP,
            *since_ms,
            true,
        )?;
    }
    // The replay's decisions stay within the bounds too. Maintenance waits
    // until every row is in place, so no replay above met a floor another
    // one moved.
    maintain_group_coverage(
        conn,
        workspace_id,
        now_ms.saturating_sub(AUTOMATION_GROUP_COVERAGE_MS),
    )?;
    Ok(AutomationGroupWatched {
        needs_handover: false,
        claims,
    })
}

fn insert_group_row(
    conn: &Connection,
    workspace_id: &str,
    subscription: &AutomationGroupSubscription,
    channel_id: &str,
    since_ms: i64,
    frozen: bool,
) -> Result<(), DomainError> {
    conn.execute(
        "INSERT INTO automation_group_subscriptions \
         (workspace_id, automation_id, channel_id, starts_with, created_at_ms, frozen) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            workspace_id,
            subscription.automation_id,
            channel_id,
            subscription.starts_with,
            since_ms,
            frozen,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// The largest generation a JSON number carries exactly.
const MAX_SAFE_GENERATION: i64 = 9_007_199_254_740_991;

/// A handover within its bounds, naming Collection automations and messages.
fn validate_group_handover(handover: &AutomationGroupHandover) -> Result<(), DomainError> {
    let invalid = || DomainError::InvalidInput {
        reason: "A Group handover is outside its bounds.",
    };
    if handover.automations.len() > MAX_AUTOMATION_GROUP_HANDOVER_AUTOMATIONS
        || handover
            .automations
            .iter()
            .map(|automation| automation.decided.len())
            .sum::<usize>()
            > MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES
    {
        return Err(invalid());
    }
    for automation in &handover.automations {
        if !is_collection_automation_id(&automation.automation_id) {
            return Err(invalid());
        }
        if automation.decided.iter().any(|(message_id, _)| {
            message_id.is_empty()
                || message_id.len() > MAX_IDENTIFIER_BYTES
                || message_id.chars().any(char::is_control)
        }) {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Decide, for one subscription that starts running here, each message
/// already stored in its Group since it starts, oldest first.
fn claim_stored_group_messages(
    conn: &Connection,
    workspace_id: &str,
    watch: &GroupWatch<'_>,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT m.message_id, m.thread_id, m.parent_message_id, m.author_kind, \
                    m.author_display_name, m.author_owner_display_name, m.author_user_id, \
                    m.body, m.created_at_ms, m.automation_id, m.chain_depth, t.lane \
             FROM chat_messages m \
             JOIN chat_threads t \
               ON t.workspace_id = m.workspace_id AND t.thread_id = m.thread_id \
             WHERE m.workspace_id = ?1 AND t.channel_id = ?2 AND m.created_at_ms >= ?3 \
             ORDER BY m.created_at_ms, m.message_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut rows = statement
        .query(params![workspace_id, watch.channel_id, watch.since_ms])
        .map_err(DomainError::sql_corrupt)?;
    let mut inserted = Vec::new();
    let mut ahead = false;
    while let Some(row) = rows.next().map_err(DomainError::sql_corrupt)? {
        let stored = (|| -> rusqlite::Result<_> {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<u32>>(10)?,
                row.get::<_, String>(11)?,
            ))
        })()
        .map_err(DomainError::sql_corrupt)?;
        let (
            message_id,
            thread_id,
            parent_message_id,
            author_kind,
            author_display_name,
            author_owner_display_name,
            author_user_id,
            body,
            created_at_ms,
            automation_id,
            chain_depth,
            lane,
        ) = stored;
        let message = AutomationGroupMessage {
            message_id: &message_id,
            thread_id: &thread_id,
            parent_message_id: parent_message_id.as_deref(),
            author_kind: &author_kind,
            author_display_name: &author_display_name,
            author_owner_display_name: author_owner_display_name.as_deref(),
            author_user_id: author_user_id.as_deref(),
            body: &body,
            created_at_ms,
            automation_id: automation_id.as_deref(),
            chain_depth,
        };
        match decide_group_message(conn, workspace_id, watch, &lane, &message)? {
            GroupDecision::Decided(claims) => inserted.extend(claims),
            GroupDecision::Ahead => ahead = true,
            GroupDecision::Passed | GroupDecision::Late => {}
        }
    }
    drop(rows);
    record_group_skips(conn, workspace_id, ahead, false)?;
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
    collection_path: Option<&'a str>,
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
    let shared_author_json =
        match &claimed.change.shared_author {
            Some(author) if author.is_valid() => Some(serde_json::to_string(author).map_err(
                |_| DomainError::InvalidInput {
                    reason: "automation claim shared author does not serialize",
                },
            )?),
            Some(_) => {
                return Err(DomainError::InvalidInput {
                    reason: "automation claim shared author is not valid",
                });
            }
            None => None,
        };
    if claimed.change.live_cursor.is_some_and(|cursor| cursor < 1) {
        return Err(DomainError::InvalidInput {
            reason: "automation claim live cursor is not positive",
        });
    }
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
                  change_fields_omitted, trigger_key, message_json, change_author_json, \
                  change_live_cursor) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?13, ?14, \
                         ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
                params![
                    workspace_id,
                    claim_id,
                    automation_id,
                    origin_id,
                    origin_seq,
                    history_id,
                    moment_order,
                    claimed.record_id,
                    claimed.collection_path.unwrap_or_default(),
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
                    shared_author_json,
                    claimed.change.live_cursor,
                ],
            )
            .map_err(DomainError::sql_persist)?;
        if rows == 1 {
            inserted.push(AutomationClaim {
                claim_id,
                automation_id: (*automation_id).to_owned(),
                trigger: claimed.trigger.clone(),
                record_id: claimed.record_id.map(str::to_owned),
                collection_path: claimed.collection_path.map(str::to_owned),
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
        collection_path: Some(&facts.collection_path),
        depth,
        change: AutomationChange {
            kind: AutomationChangeKind::Changed,
            author_origin_id: facts.author_origin_id.clone(),
            actor_kind: facts
                .attribution
                .as_ref()
                .map(|attribution| attribution.actor_kind),
            on_behalf_of: match &facts.shared_author {
                Some(SharedChangeAuthor::Named { user_id, .. }) => Some(user_id.clone()),
                Some(SharedChangeAuthor::Link { .. }) => None,
                None => facts
                    .attribution
                    .as_ref()
                    .and_then(|attribution| attribution.on_behalf_of.clone()),
            },
            shared_author: facts.shared_author.clone(),
            live_cursor: facts.live_cursor,
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
        // A moment a claim is made from was committed on this computer.
        shared_author: None,
        live_cursor: None,
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
                collection_path: Some(&record.collection_path),
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

/// A person pressed a Button field on a record, themselves or through an
/// agent acting for them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationPress {
    /// The pressing window's id for this press. A press sent again after a
    /// lost reply carries the same id.
    pub press_id: String,
    /// The automation the button runs: `collection:<collection id>#<id>`.
    pub automation_id: String,
    pub record_id: String,
    /// The person who pressed. The run acts for them.
    pub pressed_by: String,
    pub by: PressActor,
}

/// Who made a press for the person who pressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PressActor {
    Human,
    /// An agent acting for the person, named by its origin id. A press
    /// claims at the depth of the agent's run, as the agent's own writes do,
    /// so an agent an automation woke cannot start the chain over by
    /// pressing; at the cap the press stops at once.
    Agent {
        origin_id: String,
        depth: u32,
    },
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
fn button_or_schedule_automation(automation_id: &str) -> Result<(), DomainError> {
    if is_collection_automation_id(automation_id) {
        return Ok(());
    }
    Err(DomainError::InvalidInput {
        reason: "Buttons and schedules run Collection automations, collection:<collection id>#<id>.",
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
    button_or_schedule_automation(&press.automation_id)?;
    let press_id = normalize_automation_identifier(&press.press_id, "Button press id is invalid.")?;
    let record_id =
        normalize_automation_identifier(&press.record_id, "Button record id is invalid.")?;
    let pressed_by = normalize_automation_identifier(
        &press.pressed_by,
        "The person who pressed the button is invalid.",
    )?;
    let (actor_kind, author_origin_id, depth) = match &press.by {
        PressActor::Human => (ChangeActorKind::Human, None, 0),
        PressActor::Agent { origin_id, depth } => (
            ChangeActorKind::Agent,
            Some(normalize_automation_identifier(
                origin_id,
                "The agent that pressed the button is invalid.",
            )?),
            (*depth).min(AUTOMATION_CHAIN_DEPTH_CAP),
        ),
    };
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
                collection_path: None,
                depth,
                change: AutomationChange {
                    kind: AutomationChangeKind::Button,
                    author_origin_id,
                    actor_kind: Some(actor_kind),
                    on_behalf_of: Some(pressed_by.clone()),
                    shared_author: None,
                    live_cursor: None,
                },
                fields: AutomationFieldFacts::default(),
                chain_stopped: depth >= AUTOMATION_CHAIN_DEPTH_CAP,
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
    button_or_schedule_automation(&schedule.automation_id)?;
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
                    collection_path: None,
                    depth: 0,
                    change: AutomationChange {
                        kind: AutomationChangeKind::Schedule,
                        author_origin_id: None,
                        actor_kind: None,
                        on_behalf_of: None,
                        shared_author: None,
                        live_cursor: None,
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
    button_or_schedule_automation(automation_id)?;
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
        collection_path: None,
        depth: 0,
        change: AutomationChange {
            kind: AutomationChangeKind::Schedule,
            author_origin_id: None,
            actor_kind: None,
            on_behalf_of: None,
            shared_author: None,
            live_cursor: None,
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

/// Stop every Group subscription here from claiming and answer what the next
/// host needs. See [`release_automation_groups_in_tx`].
pub fn release_automation_groups(
    store: &mut EngineStore,
    workspace_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationGroupRelease, DomainError> {
    committed(store.write_with(faults, |tx| {
        release_automation_groups_in_tx(tx, workspace_id, now_ms)
    })?)
}

/// When Group messages last started nothing here for a reason a person can
/// act on. See [`AutomationGroupSkips`].
pub fn read_automation_group_skips(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<AutomationGroupSkips, DomainError> {
    store.read_with(|conn| {
        Ok(conn
            .query_row(
                "SELECT ahead_skipped_at_ms, late_skipped_at_ms FROM automation_group_state \
                 WHERE workspace_id = ?1",
                params![workspace_id],
                |row| {
                    Ok(AutomationGroupSkips {
                        ahead_at_ms: row.get(0)?,
                        late_at_ms: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .unwrap_or_default())
    })
}

/// Set the Group subscriptions this computer watches, taking a new host
/// generation's handover. See [`watch_automation_groups_in_tx`].
pub fn watch_automation_groups(
    store: &mut EngineStore,
    workspace_id: &str,
    watch: &AutomationGroupWatch,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<AutomationGroupWatched, DomainError> {
    committed(store.write_with(faults, |tx| {
        watch_automation_groups_in_tx(tx, workspace_id, watch, now_ms)
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
