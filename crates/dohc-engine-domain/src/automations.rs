//! Automation trigger claims (ADR 0008): local state in engine.db, never
//! replicated, shaped like the chat dispatch ledger. The origin device — and
//! only the origin device — turns a committed local record change into one
//! durable `automation_claims` row per subscribed automation, inside the same
//! transaction that committed the change. The desktop drains claims through
//! the pending -> running -> done | failed machine and the startup reaper
//! requeues or terminally fails claims a dead process left running.

use rusqlite::{Connection, OptionalExtension, params};

use crate::chats::base32_lowercase_no_padding;
use crate::collections::CollectionRecordApplyFacts;
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
    pub state: AutomationClaimState,
    pub attempts: i64,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
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
     created_at_ms, updated_at_ms";

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
    let claim = (|| {
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

/// Register one `(automation, collection-path prefix)` interest. Idempotent;
/// returns whether a new row was inserted.
pub fn subscribe_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    automation_id: &str,
    prefix: &str,
    now_ms: i64,
) -> Result<bool, DomainError> {
    let automation_id =
        normalize_automation_identifier(automation_id, "Automation id is invalid.")?;
    let prefix =
        normalize_automation_identifier(prefix, "Automation subscription path is invalid.")?;
    let inserted = conn
        .execute(
            "INSERT INTO automation_subscriptions \
             (workspace_id, automation_id, prefix, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(workspace_id, automation_id, prefix) DO NOTHING",
            params![workspace_id, automation_id, prefix, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(inserted == 1)
}

/// Remove one registered interest. Returns whether a row existed.
pub fn unsubscribe_automation_in_tx(
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

/// Turn one committed local apply into pending claims, in the apply's own
/// transaction. For each subscription whose prefix contains the facts'
/// collection path, except the writing automation's own subscription (an
/// automation never re-triggers itself), insert one pending claim keyed by
/// the change's trigger key. Idempotent: a re-run over the same facts hits
/// the partial unique indexes and inserts nothing. Returns only the claims
/// this call inserted.
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
            // The never-synced fallback key is the history row id. An apply
            // that wrote no field history (a bare record creation) has no
            // durable per-change key, so it cannot be claimed exactly-once.
            let Some(history_id) = facts.fields.iter().map(|field| field.history_id).min() else {
                return Ok(Vec::new());
            };
            AutomationTrigger::History { history_id }
        }
    };
    let mut statement = conn
        .prepare(
            "SELECT automation_id, prefix FROM automation_subscriptions \
             WHERE workspace_id = ?1 ORDER BY automation_id, prefix",
        )
        .map_err(DomainError::sql_corrupt)?;
    let subscriptions: Vec<(String, String)> = statement
        .query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    let mut inserted = Vec::new();
    let mut claimed_for: Option<&str> = None;
    for (automation_id, prefix) in &subscriptions {
        if !prefix_contains(prefix, &facts.collection_path) {
            continue;
        }
        if facts.author_origin_id.as_deref() == Some(automation_id.as_str()) {
            continue;
        }
        // One claim per automation even when several of its prefixes match
        // (the list is ordered by automation_id).
        if claimed_for == Some(automation_id.as_str()) {
            continue;
        }
        claimed_for = Some(automation_id.as_str());
        let claim_id = mint_claim_id()?;
        let (origin_id, origin_seq, history_id) = match &trigger {
            AutomationTrigger::Coordinate {
                origin_id,
                origin_seq,
            } => (Some(origin_id.as_str()), Some(*origin_seq), None),
            AutomationTrigger::History { history_id } => (None, None, Some(*history_id)),
        };
        let (state, error) = if chain_stopped {
            (AutomationClaimState::Failed, Some(AUTOMATION_CHAIN_STOPPED))
        } else {
            (AutomationClaimState::Pending, None)
        };
        let rows = conn
            .execute(
                "INSERT OR IGNORE INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq, \
                  trigger_history_id, record_id, collection_path, depth, state, attempts, error, \
                  created_at_ms, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?12)",
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
                ],
            )
            .map_err(DomainError::sql_persist)?;
        if rows == 1 {
            inserted.push(AutomationClaim {
                claim_id,
                automation_id: automation_id.clone(),
                trigger: trigger.clone(),
                record_id: facts.record_id.clone(),
                collection_path: facts.collection_path.clone(),
                depth,
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
/// generation IS the automation's failed-claim count — failed rows are
/// never deleted (a dismiss acknowledges, it does not destroy evidence), so
/// the count only grows, and an acknowledgment at generation N hides the
/// notice exactly until a newer failure raises it past N.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationFailure {
    pub automation_id: String,
    pub error: String,
    pub updated_at_ms: i64,
    pub generation: i64,
}

/// Every automation with at least one failed claim in this workspace,
/// ordered by automation id.
pub fn list_automation_failures_in_tx(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<AutomationFailure>, DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT automation_id, error, updated_at_ms, generation FROM ( \
                 SELECT automation_id, error, updated_at_ms, \
                        COUNT(*) OVER (PARTITION BY automation_id) AS generation, \
                        ROW_NUMBER() OVER ( \
                            PARTITION BY automation_id \
                            ORDER BY updated_at_ms DESC, claim_id DESC \
                        ) AS newest \
                 FROM automation_claims \
                 WHERE workspace_id = ?1 AND state = 'failed' \
             ) WHERE newest = 1 ORDER BY automation_id",
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

/// Flip the oldest pending claim to running with `attempts + 1` and return
/// it; `None` when nothing is pending.
pub fn claim_next_pending_automation_in_tx(
    conn: &Connection,
    workspace_id: &str,
    now_ms: i64,
) -> Result<Option<AutomationClaim>, DomainError> {
    let claim_id: Option<String> = conn
        .query_row(
            "SELECT claim_id FROM automation_claims \
             WHERE workspace_id = ?1 AND state = 'pending' \
             ORDER BY created_at_ms, claim_id LIMIT 1",
            params![workspace_id],
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
    claim_by_id(conn, workspace_id, &claim_id)?
        .ok_or(DomainError::StateCorrupt {
            reason: "claimed automation row not found after update",
        })
        .map(Some)
}

/// Close a running claim: done, or failed with the handler's error text.
/// Refuses a claim that is not running — a settle is not idempotent, matching
/// the chat ledger's exactly-one-transition rule.
pub fn settle_automation_claim_in_tx(
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
    claim_by_id(conn, workspace_id, &claim_id)?.ok_or(DomainError::StateCorrupt {
        reason: "settled automation claim not found after update",
    })
}

/// The startup reaper. A running claim whose process died — running, and not
/// touched since `stale_before_ms` — is requeued to pending while attempts
/// remain, else terminally failed with [`AUTOMATION_RECLAIM_EXHAUSTED`], the
/// chat ledger's rule. The age bound protects a claim a still-alive desktop
/// process is running across a daemon rebind. Returns every transitioned
/// claim.
pub fn reclaim_running_automations_in_tx(
    conn: &Connection,
    workspace_id: &str,
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
    let mut reclaimed = Vec::with_capacity(stale.len());
    for claim in stale {
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
    automation_id: &str,
    prefix: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<bool, DomainError> {
    committed(store.write_with(faults, |tx| {
        subscribe_automation_in_tx(tx, workspace_id, automation_id, prefix, now_ms)
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
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Option<AutomationClaim>, DomainError> {
    committed(store.write_with(faults, |tx| {
        claim_next_pending_automation_in_tx(tx, workspace_id, now_ms)
    })?)
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
    max_attempts: i64,
    stale_before_ms: i64,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Vec<AutomationClaim>, DomainError> {
    committed(store.write_with(faults, |tx| {
        reclaim_running_automations_in_tx(tx, workspace_id, max_attempts, stale_before_ms, now_ms)
    })?)
}
