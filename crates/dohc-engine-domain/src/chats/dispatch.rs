use super::{
    AgentRunRecord, DispatchClaim, DispatchRecord, DispatchRecovery, LinkedChatStore,
    MAX_DISPATCH_ID_UTF16_UNITS, RunRecordLink, ThreadDispatchPause, collect, committed,
    dispatch_corrupt, is_js_trim_ws, non_empty, normalize_verified_user_id,
    persisted_nonnegative_safe, persisted_safe_integer,
};
use crate::error::DomainError;
use dohc_engine_storage::FaultInjector;
use rusqlite::{Connection, OptionalExtension, params};

/// Dispatch metadata uses the TS store's 16,384 UTF-16-code-unit text bound.
const MAX_DISPATCH_METADATA_UTF16_UNITS: usize = 16_384;

/// Dispatch ids use `agentDispatchStore.ts`'s `normalizeRequiredId`: JS trim,
/// then reject empty, more than 512 UTF-16 code units, or NUL.
fn normalize_dispatch_id(value: &str, reason: &'static str) -> Result<String, DomainError> {
    let normalized = value.trim_matches(is_js_trim_ws);
    if normalized.is_empty()
        || normalized.encode_utf16().count() > MAX_DISPATCH_ID_UTF16_UNITS
        || normalized.contains('\0')
    {
        Err(DomainError::InvalidInput { reason })
    } else {
        Ok(normalized.to_owned())
    }
}

fn normalize_dispatch_run_id(run_id: &str) -> Result<String, DomainError> {
    normalize_dispatch_id(run_id, "Agent run id is invalid.")
}

/// Claim metadata follows `normalizeCommand`: an omitted command is the empty
/// string (the oracle's default) and empty/whitespace commands are preserved
/// verbatim — only NUL (and the daemon's metadata length cap) refuse.
fn normalize_dispatch_command(command: &str) -> Result<String, DomainError> {
    if command.contains('\0') || command.encode_utf16().count() > MAX_DISPATCH_METADATA_UTF16_UNITS
    {
        Err(DomainError::InvalidInput {
            reason: "runner command is invalid",
        })
    } else {
        Ok(command.to_owned())
    }
}

/// Optional claim log paths follow `normalizeOptionalPath`: absent is allowed;
/// present values are validated without rewriting what is persisted.
fn normalize_optional_dispatch_path(log_path: Option<&str>) -> Result<Option<String>, DomainError> {
    match log_path {
        None => Ok(None),
        Some(path)
            if path.trim_matches(is_js_trim_ws).is_empty()
                || path.contains('\0')
                || path.encode_utf16().count() > MAX_DISPATCH_METADATA_UTF16_UNITS =>
        {
            Err(DomainError::InvalidInput {
                reason: "run log path is invalid",
            })
        }
        Some(path) => Ok(Some(path.to_owned())),
    }
}

/// Failure reasons are validated using the TS store's UTF-16 length and
/// JavaScript trim semantics, while the original string is stored verbatim.
fn normalize_failure_reason(reason: &str) -> Result<String, DomainError> {
    if reason.trim_matches(is_js_trim_ws).is_empty() || reason.encode_utf16().count() > 16_384 {
        Err(DomainError::InvalidInput {
            reason: "run failure reason is invalid",
        })
    } else {
        Ok(reason.to_owned())
    }
}

fn validate_dispatch_page_limit(limit: i64) -> Result<(), DomainError> {
    if !(1..=501).contains(&limit) {
        Err(DomainError::chat(
            "invalid-cursor",
            "Page limit is invalid.",
        ))
    } else {
        Ok(())
    }
}

fn dispatch_after(after: Option<(i64, String)>) -> (i64, i64, String) {
    match after {
        Some((timestamp, id)) => (1, timestamp, id),
        None => (0, 0, String::new()),
    }
}

impl<'a> LinkedChatStore<'a> {
    // ------------------------------------------------------------- dispatch

    /// Scan new message timestamps and atomically seed all eligible, previously
    /// unseen agent triggers plus the monotonic high-water cursor.
    pub fn record_eligible_triggers(
        &mut self,
        workspace_id: &str,
        verified_user_id: Option<&str>,
        at_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<i64, DomainError> {
        non_empty(
            workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let verified_user_id = normalize_verified_user_id(verified_user_id)?;
        let outcome = self.write_with_pending_chat_replay(workspace_id, faults, |tx| {
            let prior: Option<i64> = tx
                .query_row(
                    "SELECT max_created_at_ms FROM chat_dispatch_scan_cursor \
                     WHERE workspace_id = ?1",
                    params![workspace_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let scan_after = prior.map_or(-1, |value| value.saturating_sub(1).max(-1));
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO chat_dispatch_ledger \
                     (workspace_id, trigger_message_id, thread_id, state, run_id, \
                      failure_reason, attempt_count, created_at_ms, updated_at_ms) \
                     SELECT m.workspace_id, m.message_id, m.thread_id, 'pending', NULL, \
                            NULL, 0, m.created_at_ms, ?3 \
                     FROM chat_messages m \
                     JOIN chat_threads t ON t.workspace_id = m.workspace_id \
                       AND t.thread_id = m.thread_id \
                     LEFT JOIN chat_channels c ON c.workspace_id = t.workspace_id \
                       AND c.channel_id = t.channel_id \
                     LEFT JOIN chat_dispatch_ledger l ON l.workspace_id = m.workspace_id \
                       AND l.trigger_message_id = m.message_id \
                     WHERE m.workspace_id = ?1 AND m.created_at_ms > ?2 \
                       AND l.trigger_message_id IS NULL \
                       AND m.author_kind = 'human' \
                       AND (m.origin IS NULL OR m.origin <> 'cli') \
                       AND (m.author_user_id IS NULL \
                         OR (?4 IS NOT NULL AND m.author_user_id = ?4)) \
                       AND (c.kind = 'agent' OR EXISTS ( \
                         SELECT 1 FROM chat_mentions x \
                         WHERE x.workspace_id = m.workspace_id \
                           AND x.message_id = m.message_id AND x.handle = 'agent'))",
                    params![workspace_id, scan_after, at_ms, verified_user_id],
                )
                .map_err(DomainError::sql_persist)?;
            let scanned_max: Option<i64> = tx
                .query_row(
                    "SELECT MAX(created_at_ms) FROM chat_messages \
                     WHERE workspace_id = ?1 AND created_at_ms > ?2",
                    params![workspace_id, scan_after],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if let Some(scanned_max) = scanned_max {
                tx.execute(
                    "INSERT INTO chat_dispatch_scan_cursor \
                     (workspace_id, max_created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(workspace_id) DO UPDATE SET \
                       max_created_at_ms = MAX(chat_dispatch_scan_cursor.max_created_at_ms, excluded.max_created_at_ms), \
                       updated_at_ms = excluded.updated_at_ms",
                    params![workspace_id, scanned_max, at_ms],
                )
                .map_err(DomainError::sql_persist)?;
            }
            i64::try_from(inserted).map_err(|_| dispatch_corrupt())
        })?;
        committed(outcome)
    }

    /// Enqueue a durable dispatch trigger for a message (`recordDispatchTrigger`
    /// posture): idempotent per `(workspace, trigger_message_id)`.
    pub fn enqueue_dispatch(
        &mut self,
        workspace_id: &str,
        trigger_message_id: &str,
        thread_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<bool, DomainError> {
        let ws = workspace_id.to_owned();
        let trigger = normalize_dispatch_id(trigger_message_id, "Trigger message id is invalid.")?;
        let tid = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
            let inserted = tx
                .execute(
                    "INSERT INTO chat_dispatch_ledger \
                 (workspace_id, trigger_message_id, thread_id, state, run_id, failure_reason, \
                  attempt_count, created_at_ms, updated_at_ms) \
                 VALUES (?1, ?2, ?3, 'pending', NULL, NULL, 0, ?4, ?4) \
                 ON CONFLICT(workspace_id, trigger_message_id) DO NOTHING",
                    params![ws, trigger, tid, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
            if inserted == 1 {
                return Ok::<_, DomainError>(true);
            }
            let existing_thread: Option<String> = tx
                .query_row(
                    "SELECT thread_id FROM chat_dispatch_ledger \
                     WHERE workspace_id = ?1 AND trigger_message_id = ?2",
                    params![ws, trigger],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if existing_thread.as_deref() != Some(tid.as_str()) {
                return Err(DomainError::chat(
                    "state-corrupt",
                    "Agent dispatch store is corrupt.",
                ));
            }
            Ok(false)
        })?;
        committed(outcome)
    }

    /// Claim the oldest pending, non-paused dispatch trigger (`claimNextPending`):
    /// flips it to `running`, marks every other pending trigger in the same
    /// thread `done` under the same run, mints an `agent_run_records` row, and
    /// returns the claim. Idempotent: retrying the same running `run_id`
    /// returns its existing claim; a different open run returns `None`
    /// (single-writer; no double-claim). `None` also when nothing is pending.
    pub fn claim_next_pending(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        command: &str,
        log_path: Option<&str>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<Option<DispatchClaim>, DomainError> {
        let run = normalize_dispatch_run_id(run_id)?;
        let ws = workspace_id.to_owned();
        let cmd = normalize_dispatch_command(command)?;
        let log = normalize_optional_dispatch_path(log_path)?;
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
            // A response can be lost after commit. Recover that exact durable
            // claim before the workspace-wide single-flight guard rejects it.
            if let Some(existing) = running_dispatch_claim(tx, &ws, &run)? {
                return Ok::<_, DomainError>(Some(existing));
            }
            // Run ids are globally unique by schema
            // (idx_agent_run_records_run_id); the oracle never collides
            // because it mints ids (freshRunId), while this wire contract
            // accepts caller ids for retry rehydration. Any remaining match
            // (another workspace, or an ended run in this one) must refuse
            // cleanly here rather than hit the UNIQUE violation mid-claim
            // and surface an internal error for a valid pending dispatch.
            let run_id_taken: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM agent_run_records WHERE run_id = ?1",
                    params![run],
                    |r| r.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if run_id_taken.is_some() {
                return Err(DomainError::chat(
                    "invalid-input",
                    "Agent run id is already in use.",
                ));
            }
            // Single-writer guard: a run already running means no new claim.
            let open_running: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM chat_dispatch_ledger \
                     WHERE workspace_id = ?1 AND state = 'running'",
                    params![ws],
                    |r| r.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if open_running > 0 {
                return Ok::<_, DomainError>(None);
            }
            let pending: Option<(String, String, i64, i64)> = tx
                .query_row(
                    "SELECT l.trigger_message_id, l.thread_id, l.attempt_count, l.created_at_ms \
                     FROM chat_dispatch_ledger l WHERE l.workspace_id = ?1 AND l.state = 'pending' \
                       AND NOT EXISTS (SELECT 1 FROM chat_dispatch_pause p \
                         WHERE p.workspace_id = l.workspace_id AND p.thread_id = l.thread_id \
                           AND p.paused = 1) \
                     ORDER BY l.created_at_ms, l.trigger_message_id LIMIT 1",
                    params![ws],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some((trigger, thread_id, attempt_count, created_at_ms)) = pending else {
                return Ok(None);
            };
            let updated = tx
                .execute(
                    "UPDATE chat_dispatch_ledger \
                     SET state = 'running', run_id = ?3, attempt_count = attempt_count + 1, \
                         updated_at_ms = ?4 \
                     WHERE workspace_id = ?1 AND trigger_message_id = ?2 AND state = 'pending'",
                    params![ws, trigger, run, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
            if updated != 1 {
                return Err(DomainError::StateCorrupt {
                    reason: "dispatch claim raced its own pending row",
                });
            }
            // Cover every trigger pending in this thread at claim time under one run.
            tx.execute(
                "UPDATE chat_dispatch_ledger \
                 SET state = 'done', run_id = ?3, attempt_count = attempt_count + 1, updated_at_ms = ?4 \
                 WHERE workspace_id = ?1 AND thread_id = ?2 AND state = 'pending'",
                params![ws, thread_id, run, now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO agent_run_records \
                 (workspace_id, run_id, thread_id, trigger_message_id, command, started_at_ms, \
                  ended_at_ms, exit_code, failure_reason, log_path, failure_note_posted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, 0)",
                params![ws, run, thread_id, trigger, cmd, now_ms, log],
            )
            .map_err(DomainError::sql_persist)?;
            let next_attempt_count = attempt_count.saturating_add(1);
            Ok(Some(DispatchClaim {
                dispatch: DispatchRecord {
                    workspace_id: ws.clone(),
                    trigger_message_id: trigger.clone(),
                    thread_id: thread_id.clone(),
                    state: "running".to_owned(),
                    run_id: Some(run.clone()),
                    failure_reason: None,
                    attempt_count: next_attempt_count,
                    created_at_ms,
                    updated_at_ms: now_ms,
                },
                run: AgentRunRecord {
                    workspace_id: ws.clone(),
                    run_id: run.clone(),
                    thread_id,
                    trigger_message_id: trigger,
                    command: cmd.clone(),
                    started_at_ms: now_ms,
                    ended_at_ms: None,
                    exit_code: None,
                    failure_reason: None,
                    log_path: log.clone(),
                    failure_note_posted: false,
                },
            }))
        })?;
        committed(outcome)
    }

    /// Pending dispatches in trigger-message time order. Scanner-created rows
    /// preserve the message timestamp in `created_at_ms` (F7).
    pub fn list_pending_dispatches(
        &self,
        workspace_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchRecord>, DomainError> {
        validate_dispatch_page_limit(limit)?;
        let (has_after, after_created_at_ms, after_trigger) = dispatch_after(after);
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT workspace_id, trigger_message_id, thread_id, state, run_id, \
                            failure_reason, attempt_count, created_at_ms, updated_at_ms \
                     FROM chat_dispatch_ledger \
                     WHERE workspace_id = ?1 AND state = 'pending' \
                       AND (?2 = 0 OR created_at_ms > ?3 \
                         OR (created_at_ms = ?3 AND trigger_message_id > ?4)) \
                     ORDER BY created_at_ms, trigger_message_id LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        has_after,
                        after_created_at_ms,
                        after_trigger,
                        limit
                    ],
                    |row| map_dispatch_row(row, 0),
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Open claims, after first proving the complete workspace invariant: one
    /// unended run per running ledger row and no unmatched unended run.
    pub fn list_open_dispatch_runs(
        &self,
        workspace_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchClaim>, DomainError> {
        validate_dispatch_page_limit(limit)?;
        let (has_after, after_updated_at_ms, after_trigger) = dispatch_after(after);
        self.store.read_with(|conn| {
            let broken_running: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_dispatch_ledger l \
                     WHERE l.workspace_id = ?1 AND l.state = 'running' \
                       AND (l.run_id IS NULL OR (SELECT COUNT(*) \
                         FROM agent_run_records r WHERE r.workspace_id = l.workspace_id \
                           AND r.run_id = l.run_id AND r.ended_at_ms IS NULL) <> 1))",
                    params![workspace_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            let unmatched: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_run_records r \
                     LEFT JOIN chat_dispatch_ledger l \
                       ON l.workspace_id = r.workspace_id \
                      AND l.trigger_message_id = r.trigger_message_id \
                     WHERE r.workspace_id = ?1 AND r.ended_at_ms IS NULL \
                       AND (l.trigger_message_id IS NULL OR l.state <> 'running' \
                         OR l.run_id <> r.run_id))",
                    params![workspace_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if broken_running != 0 || unmatched != 0 {
                return Err(dispatch_corrupt());
            }
            let mut stmt = conn
                .prepare_cached(
                    "SELECT l.workspace_id, l.trigger_message_id, l.thread_id, l.state, \
                            l.run_id, l.failure_reason, l.attempt_count, l.created_at_ms, \
                            l.updated_at_ms, r.workspace_id, r.run_id, r.thread_id, \
                            r.trigger_message_id, r.command, r.started_at_ms, r.ended_at_ms, \
                            r.exit_code, r.failure_reason, r.log_path, r.failure_note_posted \
                     FROM chat_dispatch_ledger l JOIN agent_run_records r \
                       ON r.workspace_id = l.workspace_id AND r.run_id = l.run_id \
                     WHERE l.workspace_id = ?1 AND l.state = 'running' \
                       AND r.ended_at_ms IS NULL \
                       AND (?2 = 0 OR l.updated_at_ms > ?3 \
                         OR (l.updated_at_ms = ?3 AND l.trigger_message_id > ?4)) \
                     ORDER BY l.updated_at_ms, l.trigger_message_id LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        has_after,
                        after_updated_at_ms,
                        after_trigger,
                        limit
                    ],
                    map_dispatch_claim_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    pub fn list_run_messages(
        &self,
        workspace_id: &str,
        run_id: &str,
        after_message_id: Option<String>,
        limit: i64,
    ) -> Result<Vec<String>, DomainError> {
        let run_id = normalize_dispatch_run_id(run_id)?;
        validate_dispatch_page_limit(limit)?;
        let (has_after, after_message_id) = match after_message_id {
            Some(message_id) => (1_i64, message_id),
            None => (0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT message_id FROM run_message_links \
                     WHERE workspace_id = ?1 AND run_id = ?2 \
                       AND (?3 = 0 OR message_id > ?4) \
                     ORDER BY message_id LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![workspace_id, run_id, has_after, after_message_id, limit],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            rows.collect::<Result<Vec<String>, _>>()
                .map_err(DomainError::sql_corrupt)
        })
    }

    pub fn dispatch_run_id_for_message(
        &self,
        workspace_id: &str,
        message_id: &str,
    ) -> Result<Option<String>, DomainError> {
        let message_id = normalize_dispatch_id(message_id, "Message id is invalid.")?;
        self.store.read_with(|conn| {
            conn.query_row(
                "SELECT run_id FROM run_message_links \
                 WHERE workspace_id = ?1 AND message_id = ?2",
                params![workspace_id, message_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)
        })
    }

    pub fn run_records_for_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
        run_limit: Option<i64>,
        after: Option<(i64, String, String)>,
        page_limit: i64,
    ) -> Result<Vec<RunRecordLink>, DomainError> {
        let thread_id = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        if run_limit.is_some_and(|limit| limit < 1) {
            return Err(DomainError::chat(
                "invalid-input",
                "Run record limit must be a positive integer.",
            ));
        }
        validate_dispatch_page_limit(page_limit)?;
        let (has_after, after_started_at_ms, after_run_id, after_message_id) = match after {
            Some((started_at_ms, run_id, message_id)) => (1_i64, started_at_ms, run_id, message_id),
            None => (0_i64, 0_i64, String::new(), String::new()),
        };
        self.store.read_with(|conn| {
            let sql = if run_limit.is_some() {
                "WITH recent_runs AS (SELECT * FROM agent_run_records \
                   WHERE workspace_id = ?1 AND thread_id = ?2 \
                   ORDER BY started_at_ms DESC, run_id DESC LIMIT ?3) \
                 SELECT links.message_id, runs.workspace_id, runs.run_id, runs.thread_id, \
                        runs.trigger_message_id, runs.command, runs.started_at_ms, \
                        runs.ended_at_ms, runs.exit_code, runs.failure_reason, runs.log_path, \
                        runs.failure_note_posted \
                 FROM run_message_links links JOIN recent_runs runs \
                   ON runs.workspace_id = links.workspace_id AND runs.run_id = links.run_id \
                 WHERE runs.workspace_id = ?1 AND runs.thread_id = ?2 \
                   AND (?4 = 0 OR runs.started_at_ms < ?5 \
                     OR (runs.started_at_ms = ?5 AND runs.run_id < ?6) \
                     OR (runs.started_at_ms = ?5 AND runs.run_id = ?6 \
                       AND links.message_id > ?7)) \
                 ORDER BY runs.started_at_ms DESC, runs.run_id DESC, links.message_id LIMIT ?8"
            } else {
                "SELECT links.message_id, runs.workspace_id, runs.run_id, runs.thread_id, \
                        runs.trigger_message_id, runs.command, runs.started_at_ms, \
                        runs.ended_at_ms, runs.exit_code, runs.failure_reason, runs.log_path, \
                        runs.failure_note_posted \
                 FROM run_message_links links JOIN agent_run_records runs \
                   ON runs.workspace_id = links.workspace_id AND runs.run_id = links.run_id \
                 WHERE runs.workspace_id = ?1 AND runs.thread_id = ?2 \
                   AND (?3 = 0 OR runs.started_at_ms < ?4 \
                     OR (runs.started_at_ms = ?4 AND runs.run_id < ?5) \
                     OR (runs.started_at_ms = ?4 AND runs.run_id = ?5 \
                       AND links.message_id > ?6)) \
                 ORDER BY runs.started_at_ms DESC, runs.run_id DESC, links.message_id LIMIT ?7"
            };
            let mut stmt = conn.prepare_cached(sql).map_err(DomainError::sql_corrupt)?;
            let map = |row: &rusqlite::Row<'_>| {
                let message_id = row.get(0)?;
                let run = map_run_row(row, 1)?;
                Ok(run.map(|run| RunRecordLink { message_id, run }))
            };
            let rows = match run_limit {
                Some(run_limit) => stmt.query_map(
                    params![
                        workspace_id,
                        thread_id,
                        run_limit,
                        has_after,
                        after_started_at_ms,
                        after_run_id,
                        after_message_id,
                        page_limit
                    ],
                    map,
                ),
                None => stmt.query_map(
                    params![
                        workspace_id,
                        thread_id,
                        has_after,
                        after_started_at_ms,
                        after_run_id,
                        after_message_id,
                        page_limit
                    ],
                    map,
                ),
            }
            .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    pub fn get_run_record(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, DomainError> {
        let run_id = normalize_dispatch_run_id(run_id)?;
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT workspace_id, run_id, thread_id, trigger_message_id, command, \
                            started_at_ms, ended_at_ms, exit_code, failure_reason, log_path, \
                            failure_note_posted FROM agent_run_records \
                     WHERE run_id = ?1 LIMIT 2",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![run_id], |row| map_run_row(row, 0))
                .map_err(DomainError::sql_corrupt)?;
            let mut runs = collect(rows)?;
            if runs.len() > 1 {
                return Err(dispatch_corrupt());
            }
            Ok(runs.pop().filter(|run| run.workspace_id == workspace_id))
        })
    }

    pub fn thread_dispatch_paused(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<bool, DomainError> {
        Ok(self
            .get_thread_dispatch_pause_state(workspace_id, thread_id)?
            .is_some_and(|pause| pause.paused))
    }

    pub fn get_thread_dispatch_pause_state(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Option<ThreadDispatchPause>, DomainError> {
        let thread_id = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        self.store.read_with(|conn| {
            conn.query_row(
                "SELECT workspace_id, thread_id, paused, reason, updated_at_ms \
                 FROM chat_dispatch_pause WHERE workspace_id = ?1 AND thread_id = ?2",
                params![workspace_id, thread_id],
                map_pause_row,
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .transpose()
        })
    }

    pub fn recent_dispatch_count(
        &self,
        workspace_id: &str,
        thread_id: &str,
        since_ms: f64,
    ) -> Result<i64, DomainError> {
        let thread_id = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        if !since_ms.is_finite() {
            return Err(DomainError::chat(
                "invalid-input",
                "Dispatch window start must be finite.",
            ));
        }
        self.store.read_with(|conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_run_records \
                     WHERE workspace_id = ?1 AND thread_id = ?2 AND started_at_ms >= ?3",
                    params![workspace_id, thread_id, since_ms],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if count < 0 {
                return Err(dispatch_corrupt());
            }
            Ok(count)
        })
    }

    pub fn fail_pending_for_thread(
        &mut self,
        workspace_id: &str,
        thread_id: &str,
        reason: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<i64, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let thread_id = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        let reason = normalize_failure_reason(reason)?;
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            let changed = tx
                .execute(
                    "UPDATE chat_dispatch_ledger SET state = 'failed', failure_reason = ?3, \
                       updated_at_ms = ?4 \
                     WHERE workspace_id = ?1 AND thread_id = ?2 AND state = 'pending'",
                    params![workspace_id, thread_id, reason, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
            i64::try_from(changed).map_err(|_| dispatch_corrupt())
        })?;
        committed(outcome)
    }

    pub fn record_run_message(
        &mut self,
        workspace_id: &str,
        message_id: &str,
        run_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<bool, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let message_id = normalize_dispatch_id(message_id, "Message id is invalid.")?;
        let run_id = normalize_dispatch_run_id(run_id)?;
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            let runs = run_rows_by_global_id(tx, &run_id)?;
            if runs.len() > 1 {
                return Err(dispatch_corrupt());
            }
            if runs
                .first()
                .is_none_or(|run| run.workspace_id != workspace_id)
            {
                return Err(DomainError::chat(
                    "run-not-found",
                    "Agent run was not found in this workspace.",
                ));
            }
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO run_message_links \
                     (workspace_id, message_id, run_id) VALUES (?1, ?2, ?3)",
                    params![workspace_id, message_id, run_id],
                )
                .map_err(DomainError::sql_persist)?;
            if inserted == 1 {
                return Ok::<_, DomainError>(true);
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT run_id FROM run_message_links \
                     WHERE workspace_id = ?1 AND message_id = ?2",
                    params![workspace_id, message_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if existing.as_deref() != Some(run_id.as_str()) {
                return Err(dispatch_corrupt());
            }
            Ok(false)
        })?;
        committed(outcome)
    }

    pub fn set_thread_dispatch_paused(
        &mut self,
        workspace_id: &str,
        thread_id: &str,
        paused: bool,
        reason: Option<&str>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ThreadDispatchPause, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let thread_id = normalize_dispatch_id(thread_id, "Thread id is invalid.")?;
        let reason = if paused {
            reason.map(normalize_failure_reason).transpose()?
        } else {
            None
        };
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            tx.execute(
                "INSERT INTO chat_dispatch_pause \
                 (workspace_id, thread_id, paused, reason, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(workspace_id, thread_id) DO UPDATE SET \
                   paused = excluded.paused, reason = excluded.reason, \
                   updated_at_ms = excluded.updated_at_ms",
                params![workspace_id, thread_id, i64::from(paused), reason, now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            tx.query_row(
                "SELECT workspace_id, thread_id, paused, reason, updated_at_ms \
                 FROM chat_dispatch_pause WHERE workspace_id = ?1 AND thread_id = ?2",
                params![workspace_id, thread_id],
                map_pause_row,
            )
            .map_err(DomainError::sql_corrupt)?
        })?;
        committed(outcome)
    }

    pub fn mark_failure_note_posted(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<AgentRunRecord, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let run_id = normalize_dispatch_run_id(run_id)?;
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            let mut runs = run_rows_by_global_id(tx, &run_id)?;
            if runs.len() > 1 {
                return Err(dispatch_corrupt());
            }
            let run = runs
                .pop()
                .filter(|run| run.workspace_id == workspace_id)
                .ok_or_else(|| DomainError::chat("run-not-found", "Agent run was not found."))?;
            if run.failure_note_posted {
                return Ok::<_, DomainError>(run);
            }
            let changed = tx
                .execute(
                    "UPDATE agent_run_records SET failure_note_posted = 1 \
                     WHERE workspace_id = ?1 AND run_id = ?2 AND failure_note_posted = 0",
                    params![workspace_id, run_id],
                )
                .map_err(DomainError::sql_persist)?;
            if changed != 1 {
                return Err(dispatch_corrupt());
            }
            require_run_in_workspace(tx, &workspace_id, &run_id)
        })?;
        committed(outcome)
    }

    pub fn requeue_failed_trigger(
        &mut self,
        workspace_id: &str,
        trigger_message_id: &str,
        run_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<bool, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let trigger_message_id =
            normalize_dispatch_id(trigger_message_id, "Trigger message id is invalid.")?;
        let run_id = normalize_dispatch_run_id(run_id)?;
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            let ended_at_ms: Option<Option<i64>> = tx
                .query_row(
                    "SELECT ended_at_ms FROM agent_run_records \
                     WHERE workspace_id = ?1 AND run_id = ?2",
                    params![workspace_id, run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if ended_at_ms.flatten().is_none() {
                return Ok::<_, DomainError>(false);
            }
            let changed = tx
                .execute(
                    "UPDATE chat_dispatch_ledger SET state = 'pending', run_id = NULL, \
                       failure_reason = NULL, updated_at_ms = ?4 \
                     WHERE workspace_id = ?1 AND trigger_message_id = ?2 \
                       AND state = 'failed' AND run_id = ?3 AND attempt_count < 2",
                    params![workspace_id, trigger_message_id, run_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
            Ok(changed == 1)
        })?;
        committed(outcome)
    }

    pub fn list_app_quit_recoveries(
        &self,
        workspace_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchRecovery>, DomainError> {
        validate_dispatch_page_limit(limit)?;
        let (has_after, after_started_at_ms, after_run_id) = dispatch_after(after);
        self.store.read_with(|conn| {
            let duplicate: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_run_records r \
                     JOIN chat_dispatch_ledger l ON l.workspace_id = r.workspace_id \
                       AND l.trigger_message_id = r.trigger_message_id AND l.run_id = r.run_id \
                     WHERE r.workspace_id = ?1 AND r.ended_at_ms IS NOT NULL \
                       AND ((r.exit_code = 143 AND r.failure_reason = 'app-quit') \
                         OR r.failure_reason = 'app restart during run') \
                       AND l.state = 'failed' \
                       AND (SELECT COUNT(*) FROM agent_run_records all_runs \
                         WHERE all_runs.run_id = r.run_id) <> 1)",
                    params![workspace_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if duplicate != 0 {
                return Err(dispatch_corrupt());
            }
            let mut stmt = conn
                .prepare_cached(
                    "SELECT r.workspace_id, r.run_id, r.thread_id, r.trigger_message_id, \
                            r.command, r.started_at_ms, r.ended_at_ms, r.exit_code, \
                            r.failure_reason, r.log_path, r.failure_note_posted, l.attempt_count \
                     FROM agent_run_records r JOIN chat_dispatch_ledger l \
                       ON l.workspace_id = r.workspace_id \
                      AND l.trigger_message_id = r.trigger_message_id AND l.run_id = r.run_id \
                     WHERE r.workspace_id = ?1 AND r.ended_at_ms IS NOT NULL \
                       AND ((r.exit_code = 143 AND r.failure_reason = 'app-quit') \
                         OR r.failure_reason = 'app restart during run') \
                       AND l.state = 'failed' \
                       AND (?2 = 0 OR r.started_at_ms > ?3 \
                         OR (r.started_at_ms = ?3 AND r.run_id > ?4)) \
                     ORDER BY r.started_at_ms, r.run_id LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        has_after,
                        after_started_at_ms,
                        after_run_id,
                        limit
                    ],
                    |row| {
                        let run = map_run_row(row, 0)?;
                        let attempt_count: i64 = row.get(11)?;
                        Ok(run.and_then(|run| {
                            if persisted_nonnegative_safe(attempt_count) {
                                Ok(DispatchRecovery { run, attempt_count })
                            } else {
                                Err(dispatch_corrupt())
                            }
                        }))
                    },
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Complete a running dispatch (`completeRun`): the `running` ledger row →
    /// `done` and its `agent_run_records` row gets `ended_at_ms`/`exit_code`.
    /// This is what unblocks the workspace's single-writer claim guard so the
    /// next pending trigger becomes claimable. Idempotent: a repeat on an already
    /// `done` run is a no-op; any other terminal state is `run-state-mismatch`.
    pub fn complete_dispatch(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        exit_code: i64,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        self.finish_dispatch(
            workspace_id,
            run_id,
            DispatchOutcomeKind::Done,
            Some(exit_code),
            None,
            now_ms,
            faults,
        )
    }

    /// Fail a running dispatch (`failRun`): the `running` ledger row → `failed`
    /// (recording `failure_reason`) and its run record gets
    /// `ended_at_ms`/`exit_code`. Idempotent on an already-`failed` run.
    pub fn fail_dispatch(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        reason: &str,
        exit_code: Option<i64>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        let run = normalize_dispatch_run_id(run_id)?;
        let reason = normalize_failure_reason(reason)?;
        self.finish_dispatch(
            workspace_id,
            &run,
            DispatchOutcomeKind::Failed,
            exit_code,
            Some(&reason),
            now_ms,
            faults,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_dispatch(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        kind: DispatchOutcomeKind,
        exit_code: Option<i64>,
        reason: Option<&str>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        let run = normalize_dispatch_run_id(run_id)?;
        let workspace_id = workspace_id.to_owned();
        let reason = reason.map(str::to_owned);
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            let Some((trigger, ended, ledger_state)) =
                dispatch_run_context(tx, &workspace_id, &run)?
            else {
                return Err(DomainError::chat(
                    "run-not-found",
                    "Agent run was not found.",
                ));
            };
            if ended.is_some() {
                // Idempotent replay iff the ledger already reached this terminal
                // state; a mismatched terminal state fails closed.
                if ledger_state.as_deref() == Some(kind.ledger_state()) {
                    return Ok::<_, DomainError>(());
                }
                return Err(DomainError::chat(
                    "run-state-mismatch",
                    "Agent run already reached a different terminal state.",
                ));
            }
            if ledger_state.as_deref() != Some("running") {
                return Err(DomainError::StateCorrupt {
                    reason: "un-ended run record has a non-running ledger row",
                });
            }
            let run_changed = tx
                .execute(
                    "UPDATE agent_run_records SET ended_at_ms = ?3, exit_code = ?4, \
                       failure_reason = COALESCE(?5, failure_reason) \
                     WHERE workspace_id = ?1 AND run_id = ?2 AND ended_at_ms IS NULL",
                    params![workspace_id, run, now_ms, exit_code, reason],
                )
                .map_err(DomainError::sql_persist)?;
            let ledger_changed = tx
                .execute(
                    "UPDATE chat_dispatch_ledger SET state = ?4, failure_reason = ?5, \
                       updated_at_ms = ?3 \
                     WHERE workspace_id = ?1 AND trigger_message_id = ?2 \
                       AND state = 'running' AND run_id = ?6",
                    params![
                        workspace_id,
                        trigger,
                        now_ms,
                        kind.ledger_state(),
                        reason,
                        run
                    ],
                )
                .map_err(DomainError::sql_persist)?;
            if run_changed != 1 || ledger_changed != 1 {
                return Err(DomainError::StateCorrupt {
                    reason: "dispatch finish did not transition exactly one run+ledger row",
                });
            }
            Ok(())
        })?;
        committed(outcome)
    }

    /// Reclaim crashed dispatches (the liveness reaper — a startup / recovery
    /// sweep with `assertOpenRunsSane`'s intent). A `running` ledger row with no
    /// live process (the run died with the crash) would otherwise wedge the
    /// single-writer claim guard forever. For each such row this marks the run
    /// record ended-with-failure, then requeues the trigger to `pending` (so a
    /// fresh worker can claim it) when `attempt_count < max_attempts`, else leaves
    /// it terminally `failed`. Returns the trigger ids requeued to `pending`.
    ///
    /// Because the engine is the single writer, this sweep is safe only when a
    /// freshly-created actor establishes the startup recovery boundary. An
    /// additional service may attach to an existing live actor while its worker
    /// is still executing and must not invoke this method.
    pub fn reclaim_running_dispatches(
        &mut self,
        workspace_id: &str,
        max_attempts: i64,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<Vec<String>, DomainError> {
        let ws = workspace_id.to_owned();
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
            // Snapshot the running rows first (can't mutate while iterating).
            let running: Vec<(String, i64, Option<String>)> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT trigger_message_id, attempt_count, run_id \
                         FROM chat_dispatch_ledger \
                         WHERE workspace_id = ?1 AND state = 'running' \
                         ORDER BY updated_at_ms, trigger_message_id",
                    )
                    .map_err(DomainError::sql_corrupt)?;
                let rows = stmt
                    .query_map(params![ws], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .map_err(DomainError::sql_corrupt)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(DomainError::sql_corrupt)?);
                }
                out
            };
            let mut requeued = Vec::new();
            for (trigger, attempt_count, run_id) in running {
                if let Some(run) = &run_id {
                    tx.execute(
                        "UPDATE agent_run_records SET ended_at_ms = ?2, exit_code = -1, \
                           failure_reason = 'reclaimed-crashed' \
                         WHERE workspace_id = ?3 AND run_id = ?1 AND ended_at_ms IS NULL",
                        params![run, now_ms, ws],
                    )
                    .map_err(DomainError::sql_persist)?;
                }
                if attempt_count < max_attempts {
                    tx.execute(
                        "UPDATE chat_dispatch_ledger SET state = 'pending', run_id = NULL, \
                           failure_reason = NULL, updated_at_ms = ?3 \
                         WHERE workspace_id = ?1 AND trigger_message_id = ?2 AND state = 'running'",
                        params![ws, trigger, now_ms],
                    )
                    .map_err(DomainError::sql_persist)?;
                    requeued.push(trigger);
                } else {
                    tx.execute(
                        "UPDATE chat_dispatch_ledger SET state = 'failed', \
                           failure_reason = 'reclaim-exhausted', updated_at_ms = ?3 \
                         WHERE workspace_id = ?1 AND trigger_message_id = ?2 AND state = 'running'",
                        params![ws, trigger, now_ms],
                    )
                    .map_err(DomainError::sql_persist)?;
                }
            }
            Ok::<_, DomainError>(requeued)
        })?;
        committed(outcome)
    }
}

/// A dispatch terminal outcome kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchOutcomeKind {
    Done,
    Failed,
}

impl DispatchOutcomeKind {
    fn ledger_state(self) -> &'static str {
        match self {
            DispatchOutcomeKind::Done => "done",
            DispatchOutcomeKind::Failed => "failed",
        }
    }
}

/// Rehydrate a lost-response retry from the one running ledger row and its
/// still-open run record. The join also makes a half-persisted pair fail closed
/// as no retry claim; the workspace guard will then surface the wedged row.
fn running_dispatch_claim(
    conn: &Connection,
    workspace_id: &str,
    run_id: &str,
) -> Result<Option<DispatchClaim>, DomainError> {
    conn.query_row(
        "SELECT l.workspace_id, l.trigger_message_id, l.thread_id, l.state, l.run_id, \
                l.failure_reason, l.attempt_count, l.created_at_ms, l.updated_at_ms, \
                r.workspace_id, r.run_id, r.thread_id, r.trigger_message_id, r.command, \
                r.started_at_ms, r.ended_at_ms, r.exit_code, r.failure_reason, r.log_path, \
                r.failure_note_posted \
         FROM chat_dispatch_ledger l \
         JOIN agent_run_records r \
           ON r.workspace_id = l.workspace_id AND r.run_id = l.run_id \
         WHERE l.workspace_id = ?1 AND l.run_id = ?2 AND l.state = 'running' \
           AND r.ended_at_ms IS NULL",
        params![workspace_id, run_id],
        |row| {
            Ok(DispatchClaim {
                dispatch: DispatchRecord {
                    workspace_id: row.get(0)?,
                    trigger_message_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    state: row.get(3)?,
                    run_id: row.get(4)?,
                    failure_reason: row.get(5)?,
                    attempt_count: row.get(6)?,
                    created_at_ms: row.get(7)?,
                    updated_at_ms: row.get(8)?,
                },
                run: AgentRunRecord {
                    workspace_id: row.get(9)?,
                    run_id: row.get(10)?,
                    thread_id: row.get(11)?,
                    trigger_message_id: row.get(12)?,
                    command: row.get(13)?,
                    started_at_ms: row.get(14)?,
                    ended_at_ms: row.get(15)?,
                    exit_code: row.get(16)?,
                    failure_reason: row.get(17)?,
                    log_path: row.get(18)?,
                    failure_note_posted: row.get(19)?,
                },
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn run_rows_by_global_id(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<AgentRunRecord>, DomainError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT workspace_id, run_id, thread_id, trigger_message_id, command, \
                    started_at_ms, ended_at_ms, exit_code, failure_reason, log_path, \
                    failure_note_posted FROM agent_run_records WHERE run_id = ?1 LIMIT 2",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![run_id], |row| map_run_row(row, 0))
        .map_err(DomainError::sql_corrupt)?;
    collect(rows)
}

fn require_run_in_workspace(
    conn: &Connection,
    workspace_id: &str,
    run_id: &str,
) -> Result<AgentRunRecord, DomainError> {
    conn.query_row(
        "SELECT workspace_id, run_id, thread_id, trigger_message_id, command, \
                started_at_ms, ended_at_ms, exit_code, failure_reason, log_path, \
                failure_note_posted FROM agent_run_records \
         WHERE workspace_id = ?1 AND run_id = ?2",
        params![workspace_id, run_id],
        |row| map_run_row(row, 0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("run-not-found", "Agent run was not found."))
}

/// Resolve a workspace-scoped run id to `(trigger_message_id, ended_at_ms,
/// ledger_state)` by joining `agent_run_records` to its dispatch ledger row.
/// `None` when the run id is unknown in that workspace.
type DispatchRunContext = (String, Option<i64>, Option<String>);

fn dispatch_run_context(
    conn: &Connection,
    workspace_id: &str,
    run_id: &str,
) -> Result<Option<DispatchRunContext>, DomainError> {
    conn.query_row(
        "SELECT r.trigger_message_id, r.ended_at_ms, l.state \
         FROM agent_run_records r \
         LEFT JOIN chat_dispatch_ledger l \
           ON l.workspace_id = r.workspace_id AND l.trigger_message_id = r.trigger_message_id \
         WHERE r.workspace_id = ?1 AND r.run_id = ?2",
        params![workspace_id, run_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn map_dispatch_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<Result<DispatchRecord, DomainError>> {
    let state: String = row.get(offset + 3)?;
    let run_id: Option<String> = row.get(offset + 4)?;
    let failure_reason: Option<String> = row.get(offset + 5)?;
    let attempt_count: i64 = row.get(offset + 6)?;
    let created_at_ms: i64 = row.get(offset + 7)?;
    let updated_at_ms: i64 = row.get(offset + 8)?;
    let valid_state = matches!(state.as_str(), "pending" | "running" | "done" | "failed");
    let valid_run = match state.as_str() {
        "pending" => run_id.is_none(),
        "running" | "done" => run_id.is_some() && attempt_count > 0,
        "failed" => run_id.is_none() || attempt_count > 0,
        _ => false,
    };
    let valid_reason = failure_reason
        .as_deref()
        .is_none_or(|reason| state == "failed" && !reason.trim_matches(is_js_trim_ws).is_empty());
    if !valid_state
        || !valid_run
        || !valid_reason
        || !persisted_nonnegative_safe(attempt_count)
        || !persisted_nonnegative_safe(created_at_ms)
        || !persisted_nonnegative_safe(updated_at_ms)
    {
        return Ok(Err(dispatch_corrupt()));
    }
    Ok(Ok(DispatchRecord {
        workspace_id: row.get(offset)?,
        trigger_message_id: row.get(offset + 1)?,
        thread_id: row.get(offset + 2)?,
        state,
        run_id,
        failure_reason,
        attempt_count,
        created_at_ms,
        updated_at_ms,
    }))
}

fn map_run_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<Result<AgentRunRecord, DomainError>> {
    let started_at_ms: i64 = row.get(offset + 5)?;
    let ended_at_ms: Option<i64> = row.get(offset + 6)?;
    let exit_code: Option<i64> = row.get(offset + 7)?;
    let failure_reason: Option<String> = row.get(offset + 8)?;
    let failure_note_posted: i64 = row.get(offset + 10)?;
    if !persisted_nonnegative_safe(started_at_ms)
        || ended_at_ms.is_some_and(|value| !persisted_nonnegative_safe(value))
        || exit_code.is_some_and(|value| !persisted_safe_integer(value))
        || ended_at_ms.is_none() && (exit_code.is_some() || failure_reason.is_some())
        || failure_reason
            .as_deref()
            .is_some_and(|reason| reason.trim_matches(is_js_trim_ws).is_empty())
        || !matches!(failure_note_posted, 0 | 1)
    {
        return Ok(Err(dispatch_corrupt()));
    }
    Ok(Ok(AgentRunRecord {
        workspace_id: row.get(offset)?,
        run_id: row.get(offset + 1)?,
        thread_id: row.get(offset + 2)?,
        trigger_message_id: row.get(offset + 3)?,
        command: row.get(offset + 4)?,
        started_at_ms,
        ended_at_ms,
        exit_code,
        failure_reason,
        log_path: row.get(offset + 9)?,
        failure_note_posted: failure_note_posted == 1,
    }))
}

fn map_dispatch_claim_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<DispatchClaim, DomainError>> {
    let dispatch = map_dispatch_row(row, 0)?;
    let run = map_run_row(row, 9)?;
    Ok(match (dispatch, run) {
        (Ok(dispatch), Ok(run))
            if dispatch.workspace_id == run.workspace_id
                && dispatch.thread_id == run.thread_id
                && dispatch.trigger_message_id == run.trigger_message_id
                && dispatch.run_id.as_deref() == Some(run.run_id.as_str())
                && dispatch.state == "running"
                && run.ended_at_ms.is_none() =>
        {
            Ok(DispatchClaim { dispatch, run })
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Err(dispatch_corrupt()),
    })
}

fn map_pause_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ThreadDispatchPause, DomainError>> {
    let paused: i64 = row.get(2)?;
    let reason: Option<String> = row.get(3)?;
    let updated_at_ms: i64 = row.get(4)?;
    if !matches!(paused, 0 | 1)
        || reason
            .as_deref()
            .is_some_and(|reason| reason.trim_matches(is_js_trim_ws).is_empty())
        || paused == 0 && reason.is_some()
        || !persisted_nonnegative_safe(updated_at_ms)
    {
        return Ok(Err(dispatch_corrupt()));
    }
    Ok(Ok(ThreadDispatchPause {
        workspace_id: row.get(0)?,
        thread_id: row.get(1)?,
        paused: paused == 1,
        reason,
        updated_at_ms,
    }))
}
