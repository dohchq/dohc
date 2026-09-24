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

use crate::chats::base32_lowercase_no_padding;
use crate::collections::{
    ChangeActorKind, CollectionFieldChangeFact, CollectionRecordApplyFacts, field_fact_value,
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
/// Failed claims stay: they are the evidence ADR 0008 keeps, and the
/// failure generation counts them.
pub const AUTOMATION_CLAIM_HISTORY_LIMIT: i64 = 100;

/// A kind of record change. A subscription names the kinds it wants; a
/// claim names the kind it runs for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationChangeKind {
    /// The apply that wrote the record's first fields
    /// ([`CollectionRecordApplyFacts::created`]).
    Added,
    /// Any later apply that changed the record's fields.
    Changed,
    /// The record left its Collection.
    Removed,
}

impl AutomationChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AutomationChangeKind::Added => "added",
            AutomationChangeKind::Changed => "changed",
            AutomationChangeKind::Removed => "removed",
        }
    }

    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "added" => Ok(AutomationChangeKind::Added),
            "changed" => Ok(AutomationChangeKind::Changed),
            "removed" => Ok(AutomationChangeKind::Removed),
            _ => Err(DomainError::StateCorrupt {
                reason: "automation change kind is not a known kind",
            }),
        }
    }

    /// The `automation_subscriptions` column that says whether a
    /// subscription wants this kind.
    fn subscription_column(self) -> &'static str {
        match self {
            AutomationChangeKind::Added => "on_added",
            AutomationChangeKind::Changed => "on_changed",
            AutomationChangeKind::Removed => "on_removed",
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

/// The change a claim runs for: its kind and who made it. `actor_kind` is
/// the declared attribution, `actor_id` the author origin; either is `None`
/// when the write did not declare it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationChange {
    pub kind: AutomationChangeKind,
    pub actor_kind: Option<ChangeActorKind>,
    pub actor_id: Option<String>,
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
    /// is in the field history row the fact names.
    Truncated {
        truncated: bool,
        bytes: usize,
    },
}

/// One changed field on a claim: the history row that recorded it and the
/// value before and after, `None` where the field was absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationFieldFact {
    #[serde(rename = "field")]
    pub field_name: String,
    pub history_id: i64,
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

/// The durable per-change key a claim holds. A synced-lineage change keys on
/// its replication coordinate — the one identifier every peer derives
/// identically — and a change no other device can see keys on this device's
/// history row id (the settled Phase 4 fallback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationTrigger {
    Coordinate { origin_id: String, origin_seq: i64 },
    History { history_id: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationClaim {
    pub claim_id: String,
    pub automation_id: String,
    pub trigger: AutomationTrigger,
    pub record_id: String,
    pub collection_path: String,
    /// The triggering change's chain depth (0 for an unattributed or
    /// human-authored trigger). The handler's own writes declare depth + 1.
    pub depth: u32,
    pub change: AutomationChange,
    pub state: AutomationClaimState,
    pub attempts: i64,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
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
     created_at_ms, updated_at_ms, change_kind, actor_kind, actor_id";

fn claim_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<AutomationClaim, DomainError>> {
    let claim_id: String = row.get(0)?;
    let automation_id: String = row.get(1)?;
    let trigger_origin_id: Option<String> = row.get(2)?;
    let trigger_origin_seq: Option<i64> = row.get(3)?;
    let trigger_history_id: Option<i64> = row.get(4)?;
    let record_id: String = row.get(5)?;
    let collection_path: String = row.get(6)?;
    let depth: i64 = row.get(7)?;
    let state: String = row.get(8)?;
    let attempts: i64 = row.get(9)?;
    let error: Option<String> = row.get(10)?;
    let created_at_ms: i64 = row.get(11)?;
    let updated_at_ms: i64 = row.get(12)?;
    let change_kind: String = row.get(13)?;
    let actor_kind: Option<String> = row.get(14)?;
    let actor_id: Option<String> = row.get(15)?;
    let claim = (|| {
        let actor_kind = actor_kind
            .map(|kind| {
                ChangeActorKind::parse(&kind).ok_or(DomainError::StateCorrupt {
                    reason: "automation claim actor kind is not a known kind",
                })
            })
            .transpose()?;
        let trigger = match (trigger_origin_id, trigger_origin_seq, trigger_history_id) {
            (Some(origin_id), Some(origin_seq), None) => AutomationTrigger::Coordinate {
                origin_id,
                origin_seq,
            },
            (None, None, Some(history_id)) => AutomationTrigger::History { history_id },
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
                actor_kind,
                actor_id,
            },
            state: AutomationClaimState::parse(&state)?,
            attempts,
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
    let prefix = normalize_automation_identifier(
        &subscription.prefix,
        "Automation subscription path is invalid.",
    )?;
    if subscription.kinds.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "Automation subscription must name at least one change kind.",
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

fn field_fact(change: &CollectionFieldChangeFact, whole: bool) -> AutomationFieldFact {
    AutomationFieldFact {
        field_name: change.field_name.clone(),
        history_id: change.history_id,
        previous: fact_value(change.previous_json.as_deref(), whole),
        next: fact_value(change.next_json.as_deref(), whole),
    }
}

/// A fact's share of the budget: its JSON plus the separating comma.
fn fact_bytes(fact: &AutomationFieldFact) -> usize {
    serde_json::to_vec(fact).map_or(usize::MAX, |json| json.len() + 1)
}

/// Bound one apply's field changes for a claim within
/// [`MAX_AUTOMATION_FIELD_FACTS_BYTES`]. Every field is named first, with
/// its values truncated; a field whose name alone does not fit is counted
/// in `omitted`. Then, in field order, values travel whole while the rest
/// of the budget allows.
fn bounded_field_facts(changes: &[CollectionFieldChangeFact]) -> AutomationFieldFacts {
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

/// Turn one committed local apply into pending claims, in the apply's own
/// transaction. An apply that wrote the record's first fields is an added
/// record; any other is a changed one. For each subscription that wants that
/// kind and whose prefix contains the facts' collection path, except the
/// writing automation's own subscription (an automation never re-triggers
/// itself), insert one pending claim keyed by the change's trigger key. A
/// changed-record subscription that names fields claims only when one of
/// them changed. Each claim carries the change's kind, actor, and bounded
/// field facts. Idempotent: a re-run over the same facts hits the partial
/// unique indexes and inserts nothing. Returns only the claims this call
/// inserted.
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
    let change = AutomationChange {
        kind: if facts.created {
            AutomationChangeKind::Added
        } else {
            AutomationChangeKind::Changed
        },
        actor_kind: facts
            .attribution
            .as_ref()
            .map(|attribution| attribution.actor_kind),
        actor_id: facts.author_origin_id.clone(),
    };
    let mut statement = conn
        .prepare(&format!(
            "SELECT automation_id, prefix, field_names_json FROM automation_subscriptions \
             WHERE workspace_id = ?1 AND {} = 1 ORDER BY automation_id, prefix",
            change.kind.subscription_column()
        ))
        .map_err(DomainError::sql_corrupt)?;
    let subscriptions: Vec<(String, String, Option<String>)> = statement
        .query_map(params![workspace_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    let mut claiming: Vec<&str> = Vec::new();
    for (automation_id, prefix, field_names_json) in &subscriptions {
        // One claim per automation even when several of its subscriptions
        // match (the list is ordered by automation_id).
        if claiming.last() == Some(&automation_id.as_str())
            || !prefix_contains(prefix, &facts.collection_path)
            || facts.author_origin_id.as_deref() == Some(automation_id.as_str())
        {
            continue;
        }
        if change.kind == AutomationChangeKind::Changed
            && !wants_changed_fields(field_names_json.as_deref(), &facts.fields)?
        {
            continue;
        }
        claiming.push(automation_id);
    }
    if claiming.is_empty() {
        return Ok(Vec::new());
    }
    let field_facts = bounded_field_facts(&facts.fields);
    let field_facts_json = serde_json::to_string(&field_facts.fields)
        .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))?;
    let (origin_id, origin_seq, history_id) = match &trigger {
        AutomationTrigger::Coordinate {
            origin_id,
            origin_seq,
        } => (Some(origin_id.as_str()), Some(*origin_seq), None),
        AutomationTrigger::History { history_id } => (None, None, Some(*history_id)),
    };
    let (state, error, failures) = if chain_stopped {
        (
            AutomationClaimState::Failed,
            Some(AUTOMATION_CHAIN_STOPPED),
            1,
        )
    } else {
        (AutomationClaimState::Pending, None, 0)
    };
    let mut inserted = Vec::new();
    for automation_id in claiming {
        let claim_id = mint_claim_id()?;
        let rows = conn
            .execute(
                "INSERT OR IGNORE INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq, \
                  trigger_history_id, record_id, collection_path, depth, state, attempts, error, \
                  created_at_ms, updated_at_ms, change_kind, actor_kind, actor_id, \
                  change_fields_json, change_fields_omitted, failures) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?12, ?13, ?14, \
                         ?15, ?16, ?17, ?18)",
                params![
                    workspace_id,
                    claim_id,
                    automation_id,
                    origin_id,
                    origin_seq,
                    history_id,
                    facts.record_id,
                    facts.collection_path,
                    i64::from(depth),
                    state.as_str(),
                    error,
                    now_ms,
                    change.kind.as_str(),
                    change.actor_kind.map(ChangeActorKind::as_str),
                    change.actor_id,
                    field_facts_json,
                    field_facts.omitted,
                    failures,
                ],
            )
            .map_err(DomainError::sql_persist)?;
        if rows == 1 {
            inserted.push(AutomationClaim {
                claim_id,
                automation_id: automation_id.to_owned(),
                trigger: trigger.clone(),
                record_id: facts.record_id.clone(),
                collection_path: facts.collection_path.clone(),
                depth,
                change: change.clone(),
                state,
                attempts: 0,
                error: error.map(str::to_owned),
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            });
        }
    }
    Ok(inserted)
}

/// One failed-claim summary per automation, for the owner-visible failure
/// surface: the newest error and its time, plus a generation. The
/// generation counts every time one of the automation's claims failed.
/// Each claim keeps its own failure count, and a claim that ever failed is
/// never pruned (a dismiss acknowledges, it does not destroy evidence), so
/// the generation only grows, even across a retry, and an acknowledgment at
/// generation N hides the notice exactly until a newer failure raises it
/// past N.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationFailure {
    pub automation_id: String,
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
            "SELECT newest.automation_id, newest.error, newest.updated_at_ms, \
                    (SELECT SUM(every.failures) FROM automation_claims every \
                     WHERE every.workspace_id = ?1 \
                       AND every.automation_id = newest.automation_id) \
             FROM ( \
                 SELECT automation_id, error, updated_at_ms, \
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
            let error: Option<String> = row.get(1)?;
            Ok(AutomationFailure {
                automation_id: row.get(0)?,
                // A failed claim always records why; a NULL here would be
                // corruption, surfaced as an empty reason rather than a
                // refused listing.
                error: error.unwrap_or_default(),
                updated_at_ms: row.get(2)?,
                generation: row.get(3)?,
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
    let (fields_json, omitted): (String, u32) = conn
        .query_row(
            "SELECT change_fields_json, change_fields_omitted FROM automation_claims \
             WHERE workspace_id = ?1 AND claim_id = ?2",
            params![workspace_id, claim_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(DomainError::sql_corrupt)?;
    let fields = serde_json::from_str(&fields_json).map_err(|_| DomainError::StateCorrupt {
        reason: "automation claim field facts are not valid facts",
    })?;
    Ok(AutomationFieldFacts { fields, omitted })
}

/// Flip the oldest pending claim to running with `attempts + 1` and return
/// it with its field facts; `None` when nothing is pending. With a prefix,
/// only claims whose automation id starts with it are served, so each
/// executor drains its own automations: the plugin executor
/// `"<plugin name>/"` per plugin, the Collection executor `"collection:"`
/// (its ids are `collection:<collection path>#<automation id>`).
pub(crate) fn claim_next_pending_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id_prefix: Option<&str>,
    now_ms: i64,
) -> Result<Option<(AutomationClaim, AutomationFieldFacts)>, DomainError> {
    if automation_id_prefix.is_some_and(|prefix| {
        prefix.is_empty() || prefix.len() > MAX_IDENTIFIER_BYTES || prefix.contains('\0')
    }) {
        return Err(DomainError::InvalidInput {
            reason: "Automation id prefix is invalid.",
        });
    }
    let claim_id: Option<String> = conn
        .query_row(
            "SELECT claim_id FROM automation_claims \
             WHERE workspace_id = ?1 AND state = 'pending' \
               AND (?2 IS NULL OR substr(automation_id, 1, length(?2)) = ?2) \
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

/// Queue a failed claim to run again with the facts it already holds. The
/// next `claimNext` serves it as a new attempt, so the attempt count keeps
/// rising. A claim already pending or running is returned unchanged. A done
/// claim, and a claim the chain depth cap stopped, cannot run again.
pub(crate) fn retry_automation_claim_in_tx(
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
    match existing.state {
        AutomationClaimState::Pending | AutomationClaimState::Running => return Ok(existing),
        AutomationClaimState::Done => {
            return Err(DomainError::InvalidInput {
                reason: "Automation claim is done.",
            });
        }
        AutomationClaimState::Failed
            if existing.error.as_deref() == Some(AUTOMATION_CHAIN_STOPPED) =>
        {
            return Err(DomainError::InvalidInput {
                reason: "A claim the chain depth cap stopped cannot run.",
            });
        }
        AutomationClaimState::Failed => {}
    }
    let rows = conn
        .execute(
            "UPDATE automation_claims \
             SET state = 'pending', error = NULL, updated_at_ms = ?3 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'failed'",
            params![workspace_id, claim_id, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if rows != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "automation claim vanished mid-retry under the single writer",
        });
    }
    claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
        reason: "retried automation claim not found after update",
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
             SET state = ?3, error = ?4, updated_at_ms = ?5, failures = failures + ?6 \
             WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'running'",
            params![
                workspace_id,
                claim_id,
                state.as_str(),
                error,
                now_ms,
                i64::from(state == AutomationClaimState::Failed),
            ],
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
    conn.execute(
        "DELETE FROM automation_claims \
         WHERE workspace_id = ?1 AND automation_id = ?2 AND state = 'done' AND failures = 0 \
           AND claim_id NOT IN ( \
               SELECT claim_id FROM automation_claims \
               WHERE workspace_id = ?1 AND automation_id = ?2 \
               ORDER BY created_at_ms DESC, claim_id DESC LIMIT ?3)",
        params![
            workspace_id,
            settled.automation_id,
            AUTOMATION_CLAIM_HISTORY_LIMIT
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(settled)
}

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
                 SET state = ?3, error = ?4, updated_at_ms = ?5, failures = failures + ?6 \
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
                    i64::from(exhausted),
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
    automation_id_prefix: Option<&str>,
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
) -> Result<AutomationClaim, DomainError> {
    committed(store.write_with(faults, |tx| {
        retry_automation_claim_in_tx(tx, workspace_id, claim_id, now_ms)
    })?)
}

pub fn list_automation_claims(
    store: &EngineStore,
    workspace_id: &str,
    automation_id: &str,
) -> Result<Vec<AutomationClaim>, DomainError> {
    store.read_with(|conn| list_automation_claims_in_tx(conn, workspace_id, automation_id))
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
