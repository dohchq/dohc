//! Stage receipts: what one keyed chat write committed, written in the
//! write's own transaction. A caller that lost the write's answer reads its
//! receipt to learn whether it committed, which journal rows it added, and
//! how far each has been pushed.

use super::{
    ChatActorKind, ChatDecision, ChatDecisionState, ChatReaction, ChatReactionState, ChatThread,
    ChatThreadLane, LinkedChatStore,
};
use crate::error::DomainError;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

/// The most stage keys one publication-state read answers.
pub const MAX_PUBLICATION_STAGE_KEYS: usize = 256;

/// What a committed stage did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatStageOutcome {
    Written,
    /// The question was already resolved by the reply this stage names.
    NoOp,
    /// Another reply had already resolved the question.
    Lost,
}

impl ChatStageOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Written => "written",
            Self::NoOp => "no-op",
            Self::Lost => "lost",
        }
    }

    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "written" => Ok(Self::Written),
            "no-op" => Ok(Self::NoOp),
            "lost" => Ok(Self::Lost),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat stage receipt has an unknown outcome",
            }),
        }
    }
}

/// How far one journal row of a stage has been published.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatCoordinateState {
    Pushed,
    Pending,
    Refused,
}

impl ChatCoordinateState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pushed => "pushed",
            Self::Pending => "pending",
            Self::Refused => "refused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCoordinatePublication {
    pub origin_id: String,
    pub origin_seq: i64,
    pub state: ChatCoordinateState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatStageReceipt {
    pub outcome: ChatStageOutcome,
    pub thread_id: String,
    pub winner_message_id: Option<String>,
    pub coordinates: Vec<ChatCoordinatePublication>,
}

/// One requested stage key and its receipt, or `None` when no stage with
/// that key committed in the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatStagePublication {
    pub stage_key: String,
    pub receipt: Option<ChatStageReceipt>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCoordinate {
    origin_id: String,
    origin_seq: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredThread {
    workspace_id: String,
    thread_id: String,
    title: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    lane: String,
    channel_id: Option<String>,
    linked_object_id: Option<String>,
    linked_path_hint: Option<String>,
    linked_at_ms: Option<i64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDecision {
    thread_id: String,
    message_id: String,
    state: String,
    resolved_by_message_id: Option<String>,
    at_ms: i64,
    options: Vec<String>,
    chosen_option: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReaction {
    reaction_id: String,
    thread_id: String,
    message_id: String,
    emoji: String,
    author_id: String,
    author_kind: String,
    author_display_name: String,
    state: String,
    at_ms: i64,
}

fn corrupt_receipt() -> DomainError {
    DomainError::StateCorrupt {
        reason: "chat stage receipt is corrupt",
    }
}

/// Where the workspace's local journal ended before a stage wrote: its origin
/// and that origin's last sequence, or `None` before it has an origin. Read
/// it before the stage's first journal row.
pub(super) struct JournalMark(Option<(String, i64)>);

pub(super) fn journal_mark(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<JournalMark, DomainError> {
    tx.query_row(
        "SELECT s.origin_id, COALESCE((SELECT MAX(r.origin_seq) FROM replication_log r \
            WHERE r.workspace_id = s.workspace_id AND r.origin_id = s.origin_id), -1) \
         FROM sync_identity s WHERE s.workspace_id = ?1",
        [workspace_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map(JournalMark)
    .map_err(DomainError::sql_corrupt)
}

/// The local journal rows inserted after `mark`, in sequence order. The
/// allocator takes each next sequence after the origin's maximum, so these
/// are exactly the rows this transaction added.
fn emitted_since(
    tx: &Transaction<'_>,
    workspace_id: &str,
    mark: &JournalMark,
) -> Result<Vec<StoredCoordinate>, DomainError> {
    let (origin_id, after) = match &mark.0 {
        Some((origin_id, after)) => (origin_id.clone(), *after),
        None => match tx
            .query_row(
                "SELECT origin_id FROM sync_identity WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
        {
            Some(origin_id) => (origin_id, -1),
            None => return Ok(Vec::new()),
        },
    };
    let mut stmt = tx
        .prepare_cached(
            "SELECT origin_seq FROM replication_log \
             WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq > ?3 AND imported = 0 \
             ORDER BY origin_seq",
        )
        .map_err(DomainError::sql_corrupt)?;
    let sequences = stmt
        .query_map(params![workspace_id, origin_id, after], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(DomainError::sql_corrupt)?;
    Ok(sequences
        .into_iter()
        .map(|origin_seq| StoredCoordinate {
            origin_id: origin_id.clone(),
            origin_seq,
        })
        .collect())
}

/// What a stage answered and a retry answers again: the thread a start
/// returned, or the cell a resolve or reaction returned. A sent message is
/// immutable, so a send keeps nothing.
pub(super) enum StageResult<'a> {
    Message,
    Thread(&'a ChatThread),
    Decision(&'a ChatDecision),
    Reaction(&'a ChatReaction),
}

/// Write the receipt of the stage `stage_key` in the stage's transaction. A
/// written stage that added no journal row never reaches another copy, so it
/// fails and its transaction rolls back.
#[allow(clippy::too_many_arguments)]
pub(super) fn record_receipt(
    tx: &Transaction<'_>,
    workspace_id: &str,
    stage_key: &str,
    outcome: ChatStageOutcome,
    thread_id: &str,
    winner_message_id: Option<&str>,
    mark: &JournalMark,
    result: StageResult<'_>,
) -> Result<(), DomainError> {
    let emitted = emitted_since(tx, workspace_id, mark)?;
    if outcome == ChatStageOutcome::Written && emitted.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "stage-not-published",
        });
    }
    let coordinates = serde_json::to_string(&emitted).map_err(|_| corrupt_receipt())?;
    let result_json = match result {
        StageResult::Message => None,
        StageResult::Thread(thread) => Some(serde_json::to_string(&StoredThread {
            workspace_id: thread.workspace_id.clone(),
            thread_id: thread.thread_id.clone(),
            title: thread.title.clone(),
            created_at_ms: thread.created_at_ms,
            updated_at_ms: thread.updated_at_ms,
            lane: thread.lane.as_str().to_owned(),
            channel_id: thread.channel_id.clone(),
            linked_object_id: thread.linked_object_id.clone(),
            linked_path_hint: thread.linked_path_hint.clone(),
            linked_at_ms: thread.linked_at_ms,
        })),
        StageResult::Decision(decision) => Some(serde_json::to_string(&StoredDecision {
            thread_id: decision.thread_id.clone(),
            message_id: decision.message_id.clone(),
            state: decision.state.as_str().to_owned(),
            resolved_by_message_id: decision.resolved_by_message_id.clone(),
            at_ms: decision.at_ms,
            options: decision.options.clone(),
            chosen_option: decision.chosen_option.clone(),
        })),
        StageResult::Reaction(reaction) => Some(serde_json::to_string(&StoredReaction {
            reaction_id: reaction.reaction_id.clone(),
            thread_id: reaction.thread_id.clone(),
            message_id: reaction.message_id.clone(),
            emoji: reaction.emoji.clone(),
            author_id: reaction.author_id.clone(),
            author_kind: reaction.author_kind.as_str().to_owned(),
            author_display_name: reaction.author_display_name.clone(),
            state: reaction.state.as_str().to_owned(),
            at_ms: reaction.at_ms,
        })),
    }
    .transpose()
    .map_err(|_| corrupt_receipt())?;
    tx.execute(
        "INSERT INTO chat_stage_receipts \
         (workspace_id, stage_key, outcome, thread_id, winner_message_id, coordinates_json, result_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            workspace_id,
            stage_key,
            outcome.as_str(),
            thread_id,
            winner_message_id,
            coordinates,
            result_json
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// The cell a receipt kept, or `None` when the workspace has no receipt for
/// the key.
fn stored_result(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<Option<String>, DomainError> {
    let stored: Option<Option<String>> = conn
        .query_row(
            "SELECT result_json FROM chat_stage_receipts WHERE workspace_id = ?1 AND stage_key = ?2",
            params![workspace_id, stage_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    stored
        .map(|json| json.ok_or_else(corrupt_receipt))
        .transpose()
}

fn has_receipt(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_stage_receipts WHERE workspace_id = ?1 AND stage_key = ?2)",
        params![workspace_id, stage_key],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

pub(super) fn replayed_thread(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<Option<ChatThread>, DomainError> {
    let Some(json) = stored_result(conn, workspace_id, stage_key)? else {
        return Ok(None);
    };
    let stored: StoredThread = serde_json::from_str(&json).map_err(|_| corrupt_receipt())?;
    Ok(Some(ChatThread {
        workspace_id: stored.workspace_id,
        thread_id: stored.thread_id,
        title: stored.title,
        created_at_ms: stored.created_at_ms,
        updated_at_ms: stored.updated_at_ms,
        lane: ChatThreadLane::from_db(&stored.lane)?,
        channel_id: stored.channel_id,
        linked_object_id: stored.linked_object_id,
        linked_path_hint: stored.linked_path_hint,
        linked_at_ms: stored.linked_at_ms,
    }))
}

pub(super) fn replayed_decision(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<Option<ChatDecision>, DomainError> {
    let Some(json) = stored_result(conn, workspace_id, stage_key)? else {
        return Ok(None);
    };
    let stored: StoredDecision = serde_json::from_str(&json).map_err(|_| corrupt_receipt())?;
    Ok(Some(ChatDecision {
        thread_id: stored.thread_id,
        message_id: stored.message_id,
        state: ChatDecisionState::from_db(&stored.state)?,
        resolved_by_message_id: stored.resolved_by_message_id,
        at_ms: stored.at_ms,
        options: stored.options,
        chosen_option: stored.chosen_option,
    }))
}

pub(super) fn replayed_reaction(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<Option<ChatReaction>, DomainError> {
    let Some(json) = stored_result(conn, workspace_id, stage_key)? else {
        return Ok(None);
    };
    let stored: StoredReaction = serde_json::from_str(&json).map_err(|_| corrupt_receipt())?;
    Ok(Some(ChatReaction {
        reaction_id: stored.reaction_id,
        thread_id: stored.thread_id,
        message_id: stored.message_id,
        emoji: stored.emoji,
        author_id: stored.author_id,
        author_kind: ChatActorKind::from_db(&stored.author_kind)?,
        author_display_name: stored.author_display_name,
        state: ChatReactionState::from_db(&stored.state)?,
        at_ms: stored.at_ms,
    }))
}

/// A refusal recorded for the row, by a pending refusal notice or by the
/// settlement admission that outlives the notice's dismissal; otherwise
/// pushed at or below the origin's push cursor; otherwise pending.
fn coordinate_state(
    conn: &Connection,
    workspace_id: &str,
    coordinate: &StoredCoordinate,
) -> Result<ChatCoordinateState, DomainError> {
    let state: String = conn
        .query_row(
            "SELECT CASE \
               WHEN EXISTS(SELECT 1 FROM replication_pending_refusals \
                   WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3) \
                 OR EXISTS(SELECT 1 FROM live_settlement_publication_admissions \
                   WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3 \
                     AND json_extract(admission_json, '$.status') = 'refused') \
                 THEN 'refused' \
               WHEN ?3 <= COALESCE((SELECT pushed_seq FROM sync_relay_push_state \
                   WHERE workspace_id = ?1 AND origin_id = ?2), -1) \
                 THEN 'pushed' \
               ELSE 'pending' END",
            params![workspace_id, coordinate.origin_id, coordinate.origin_seq],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    Ok(match state.as_str() {
        "refused" => ChatCoordinateState::Refused,
        "pushed" => ChatCoordinateState::Pushed,
        _ => ChatCoordinateState::Pending,
    })
}

fn stage_publication(
    conn: &Connection,
    workspace_id: &str,
    stage_key: &str,
) -> Result<ChatStagePublication, DomainError> {
    let row: Option<(String, String, Option<String>, String)> = conn
        .query_row(
            "SELECT outcome, thread_id, winner_message_id, coordinates_json \
             FROM chat_stage_receipts WHERE workspace_id = ?1 AND stage_key = ?2",
            params![workspace_id, stage_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let receipt = row
        .map(|(outcome, thread_id, winner_message_id, coordinates)| {
            let coordinates: Vec<StoredCoordinate> =
                serde_json::from_str(&coordinates).map_err(|_| corrupt_receipt())?;
            let coordinates = coordinates
                .into_iter()
                .map(|coordinate| {
                    let state = coordinate_state(conn, workspace_id, &coordinate)?;
                    Ok(ChatCoordinatePublication {
                        origin_id: coordinate.origin_id,
                        origin_seq: coordinate.origin_seq,
                        state,
                    })
                })
                .collect::<Result<Vec<_>, DomainError>>()?;
            Ok::<_, DomainError>(ChatStageReceipt {
                outcome: ChatStageOutcome::from_db(&outcome)?,
                thread_id,
                winner_message_id,
                coordinates,
            })
        })
        .transpose()?;
    Ok(ChatStagePublication {
        stage_key: stage_key.to_owned(),
        receipt,
    })
}

impl LinkedChatStore<'_> {
    /// A retry on a handle that records receipts replays only a stage that
    /// recorded one. A key first used without a receipt would otherwise read
    /// as absent although its write committed.
    pub(super) fn require_stage_receipt(
        &self,
        workspace_id: &str,
        stage_key: &str,
    ) -> Result<(), DomainError> {
        if !self.stage_receipts {
            return Ok(());
        }
        let receipted = self
            .store
            .read_with(|conn| has_receipt(conn, workspace_id, stage_key))?;
        if receipted {
            Ok(())
        } else {
            Err(DomainError::IdempotencyKeyReuseMismatch)
        }
    }

    /// Each stage key's receipt and how far each of its journal rows has been
    /// published, all read from one snapshot.
    pub fn publication_state(
        &self,
        workspace_id: &str,
        stage_keys: &[String],
    ) -> Result<Vec<ChatStagePublication>, DomainError> {
        if stage_keys.len() > MAX_PUBLICATION_STAGE_KEYS {
            return Err(DomainError::InvalidInput {
                reason: "too many stage keys",
            });
        }
        self.store.read_with(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(DomainError::sql_corrupt)?;
            let answer = stage_keys
                .iter()
                .map(|stage_key| stage_publication(&tx, workspace_id, stage_key))
                .collect::<Result<Vec<_>, _>>()?;
            tx.rollback().map_err(DomainError::sql_corrupt)?;
            Ok(answer)
        })
    }
}
