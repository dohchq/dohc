use crate::EngineService;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::ChatPageParams;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_cursor;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::chats::threads::ChatThreadParams;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::AgentRunRecord;
use dohc_engine_domain::DispatchClaim;
use dohc_engine_domain::DispatchRecord;
use dohc_engine_domain::ThreadDispatchPause;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

pub(crate) const CHAT_DISPATCH_MAX_ATTEMPTS: i64 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchEnqueueParams {
    trigger_message_id: String,
    agent_id: String,
    thread_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchClaimParams {
    run_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    command: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    log_path: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRunPageParams {
    run_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchMessageParams {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchThreadRunsParams {
    thread_id: String,
    limit: Option<i64>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRunParams {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRecentCountParams {
    thread_id: String,
    since_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchFailPendingParams {
    thread_id: String,
    agent_id: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchLatestRunParams {
    thread_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    agent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRecordRunMessageParams {
    message_id: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchSetPausedParams {
    thread_id: String,
    paused: bool,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRequeueParams {
    trigger_message_id: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchCompleteParams {
    run_id: String,
    exit_code: i64,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchFailParams {
    run_id: String,
    reason: String,
    exit_code: Option<i64>,
    now_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchClaimWire<'a> {
    dispatch: DispatchWire<'a>,
    run: RunWire<'a>,
    chain_depth: u32,
}

fn dispatch_claim_json(claim: &DispatchClaim) -> Value {
    json!(DispatchClaimWire {
        dispatch: DispatchWire::from(&claim.dispatch),
        run: RunWire::from(&claim.run),
        chain_depth: claim.chain_depth,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchWire<'a> {
    workspace_id: &'a str,
    trigger_message_id: &'a str,
    agent_id: &'a str,
    thread_id: &'a str,
    state: &'a str,
    attempt_count: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<&'a str>,
}

impl<'a> From<&'a DispatchRecord> for DispatchWire<'a> {
    fn from(dispatch: &'a DispatchRecord) -> Self {
        DispatchWire {
            workspace_id: &dispatch.workspace_id,
            trigger_message_id: &dispatch.trigger_message_id,
            agent_id: &dispatch.agent_id,
            thread_id: &dispatch.thread_id,
            state: &dispatch.state,
            attempt_count: dispatch.attempt_count,
            created_at_ms: dispatch.created_at_ms,
            updated_at_ms: dispatch.updated_at_ms,
            run_id: dispatch.run_id.as_deref(),
            failure_reason: dispatch.failure_reason.as_deref(),
        }
    }
}

fn dispatch_json(dispatch: &DispatchRecord) -> Value {
    json!(DispatchWire::from(dispatch))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunWire<'a> {
    workspace_id: &'a str,
    run_id: &'a str,
    agent_id: &'a str,
    thread_id: &'a str,
    trigger_message_id: &'a str,
    command: &'a str,
    started_at_ms: i64,
    failure_handled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_path: Option<&'a str>,
}

impl<'a> From<&'a AgentRunRecord> for RunWire<'a> {
    fn from(run: &'a AgentRunRecord) -> Self {
        RunWire {
            workspace_id: &run.workspace_id,
            run_id: &run.run_id,
            agent_id: &run.agent_id,
            thread_id: &run.thread_id,
            trigger_message_id: &run.trigger_message_id,
            command: &run.command,
            started_at_ms: run.started_at_ms,
            failure_handled: run.failure_handled,
            ended_at_ms: run.ended_at_ms,
            exit_code: run.exit_code,
            failure_reason: run.failure_reason.as_deref(),
            log_path: run.log_path.as_deref(),
        }
    }
}

fn run_json(run: &AgentRunRecord) -> Value {
    json!(RunWire::from(run))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PauseWire<'a> {
    workspace_id: &'a str,
    thread_id: &'a str,
    paused: bool,
    updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
}

fn pause_json(pause: &ThreadDispatchPause) -> Value {
    json!(PauseWire {
        workspace_id: &pause.workspace_id,
        thread_id: &pause.thread_id,
        paused: pause.paused,
        updated_at_ms: pause.updated_at_ms,
        reason: pause.reason.as_deref(),
    })
}

impl EngineService {
    pub(crate) async fn chats_dispatch_enqueue(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchEnqueueParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let enqueued = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.enqueue",
            open.actor.chat_dispatch_enqueue(
                open.workspace_id.clone(),
                params.trigger_message_id,
                params.agent_id,
                params.thread_id,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "enqueued": enqueued }))
    }

    pub(crate) async fn chats_dispatch_claim_next_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchClaimParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claim = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.claimNextPending",
            open.actor.chat_dispatch_claim_next_pending(
                open.workspace_id.clone(),
                params.run_id,
                params.command.unwrap_or_default(),
                params.log_path,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(claim
            .as_ref()
            .map(dispatch_claim_json)
            .unwrap_or(Value::Null))
    }

    pub(crate) async fn chats_dispatch_list_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding("chats.dispatch.listPending", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .map(|cursor| {
                let agent_id = cursor
                    .third
                    .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-cursor"))?;
                Ok::<_, WireError>((cursor.first, cursor.second, agent_id))
            })
            .transpose()?;
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listPending",
            open.actor
                .chat_dispatch_list_pending(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(dispatch_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: last.created_at_ms,
                second: last.trigger_message_id.clone(),
                third: Some(last.agent_id.clone()),
            })?)
        } else {
            None
        };
        Ok(json!({
            "dispatches": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_dispatch_open_runs(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding("chats.dispatch.openRuns", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.openRuns",
            open.actor
                .chat_dispatch_open_runs(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(dispatch_claim_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = chat_page_cursor(&rows, included, binding, |claim| {
            (
                claim.dispatch.updated_at_ms,
                claim.dispatch.trigger_message_id.clone(),
            )
        })?;
        Ok(json!({
            "claims": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_dispatch_list_run_messages(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.dispatch.listRunMessages",
            &workspace_id,
            &[&params.run_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listRunMessages",
            open.actor.chat_dispatch_list_run_messages(
                workspace_id,
                params.run_id,
                cursor.as_ref().map(|cursor| cursor.second.clone()),
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|message_id| json!(message_id))
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: 0,
                second: last.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "messageIds": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_dispatch_run_id_for_message(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchMessageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run_id = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.runIdForMessage",
            open.actor
                .chat_dispatch_run_id_for_message(open.workspace_id.clone(), params.message_id),
        )
        .await?;
        Ok(run_id.map_or(Value::Null, Value::String))
    }

    pub(crate) async fn chats_dispatch_run_records_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchThreadRunsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let limit_binding = params
            .limit
            .map_or_else(String::new, |limit| limit.to_string());
        let binding = chat_cursor_binding(
            "chats.dispatch.runRecordsForThread",
            &workspace_id,
            &[&params.thread_id, &limit_binding],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = match &cursor {
            None => None,
            Some(cursor) => Some((
                cursor.first,
                cursor.second.clone(),
                cursor
                    .third
                    .clone()
                    .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-cursor"))?,
            )),
        };
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.runRecordsForThread",
            open.actor.chat_dispatch_run_records_for_thread(
                workspace_id,
                params.thread_id,
                params.limit,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let entry_values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|row| {
                let mut entry = serde_json::Map::new();
                entry.insert(row.message_id.clone(), run_json(&row.run));
                Value::Object(entry)
            })
            .collect();
        let included = bounded_chat_page_len(&entry_values)?;
        let mut runs = serde_json::Map::new();
        for row in rows.iter().take(included) {
            runs.insert(row.message_id.clone(), run_json(&row.run));
        }
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: last.run.started_at_ms,
                second: last.run.run_id.clone(),
                third: Some(last.message_id.clone()),
            })?)
        } else {
            None
        };
        Ok(json!({ "runs": runs, "nextCursor": next_cursor }))
    }

    pub(crate) async fn chats_dispatch_latest_run_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchLatestRunParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.latestRunForThread",
            open.actor.chat_dispatch_latest_run_for_thread(
                open.workspace_id.clone(),
                params.thread_id,
                params.agent_id,
            ),
        )
        .await?;
        Ok(run.as_ref().map(run_json).unwrap_or(Value::Null))
    }

    pub(crate) async fn chats_dispatch_get_run_record(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.getRunRecord",
            open.actor
                .chat_dispatch_get_run_record(open.workspace_id.clone(), params.run_id),
        )
        .await?;
        Ok(run.as_ref().map(run_json).unwrap_or(Value::Null))
    }

    pub(crate) async fn chats_dispatch_thread_paused(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let paused = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.isThreadPaused",
            open.actor
                .chat_dispatch_thread_paused(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(json!(paused))
    }

    pub(crate) async fn chats_dispatch_get_thread_pause_state(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pause = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.getThreadPauseState",
            open.actor
                .chat_dispatch_get_thread_pause_state(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(pause.as_ref().map(pause_json).unwrap_or(Value::Null))
    }

    pub(crate) async fn chats_dispatch_recent_count(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRecentCountParams = parse(params)?;
        if !params.since_ms.is_finite() {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let count = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.recentCount",
            open.actor.chat_dispatch_recent_count(
                open.workspace_id.clone(),
                params.thread_id,
                params.since_ms,
            ),
        )
        .await?;
        Ok(json!(count))
    }

    pub(crate) async fn chats_dispatch_fail_pending_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchFailPendingParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let changed = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.failPendingForThread",
            open.actor.chat_dispatch_fail_pending_for_thread(
                open.workspace_id.clone(),
                params.thread_id,
                params.agent_id,
                params.reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(changed))
    }

    pub(crate) async fn chats_dispatch_record_run_message(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRecordRunMessageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let inserted = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.recordRunMessage",
            open.actor.chat_dispatch_record_run_message(
                open.workspace_id.clone(),
                params.message_id,
                params.run_id,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(inserted))
    }

    pub(crate) async fn chats_dispatch_set_thread_paused(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchSetPausedParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pause = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.setThreadPaused",
            open.actor.chat_dispatch_set_thread_paused(
                open.workspace_id.clone(),
                params.thread_id,
                params.paused,
                params.reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(pause_json(&pause))
    }

    pub(crate) async fn chats_dispatch_mark_failure_handled(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.markFailureHandled",
            open.actor.chat_dispatch_mark_failure_handled(
                open.workspace_id.clone(),
                params.run_id,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(run_json(&run))
    }

    pub(crate) async fn chats_dispatch_requeue_failed_trigger(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRequeueParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let requeued = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.requeueFailedTrigger",
            open.actor.chat_dispatch_requeue_failed_trigger(
                open.workspace_id.clone(),
                params.trigger_message_id,
                params.run_id,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(requeued))
    }

    pub(crate) async fn chats_dispatch_list_app_quit_recoveries(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding =
            chat_cursor_binding("chats.dispatch.listAppQuitRecoveries", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listAppQuitRecoveries",
            open.actor
                .chat_dispatch_list_app_quit_recoveries(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|recovery| {
                json!({
                    "run": run_json(&recovery.run),
                    "attemptCount": recovery.attempt_count,
                })
            })
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = chat_page_cursor(&rows, included, binding, |recovery| {
            (recovery.run.started_at_ms, recovery.run.run_id.clone())
        })?;
        Ok(json!({
            "recoveries": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_dispatch_complete(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchCompleteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.complete",
            open.actor.chat_dispatch_complete(
                open.workspace_id.clone(),
                params.run_id,
                params.exit_code,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "completed": true }))
    }

    pub(crate) async fn chats_dispatch_fail(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchFailParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.fail",
            open.actor.chat_dispatch_fail(
                open.workspace_id.clone(),
                params.run_id,
                params.reason,
                params.exit_code,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "failed": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> AgentRunRecord {
        AgentRunRecord {
            workspace_id: "workspace".to_owned(),
            run_id: "run".to_owned(),
            agent_id: "default".to_owned(),
            thread_id: "thread".to_owned(),
            trigger_message_id: "message".to_owned(),
            command: String::new(),
            started_at_ms: 10,
            ended_at_ms: None,
            exit_code: None,
            failure_reason: None,
            log_path: None,
            failure_handled: false,
        }
    }

    #[test]
    fn dispatch_claim_omits_absent_outcomes_and_keeps_chain_depth() {
        let claim = DispatchClaim {
            dispatch: DispatchRecord {
                workspace_id: "workspace".to_owned(),
                trigger_message_id: "message".to_owned(),
                agent_id: "default".to_owned(),
                thread_id: "thread".to_owned(),
                state: "pending".to_owned(),
                run_id: None,
                failure_reason: None,
                attempt_count: 0,
                created_at_ms: 9,
                updated_at_ms: 9,
            },
            run: run(),
            chain_depth: 2,
        };
        assert_eq!(
            dispatch_claim_json(&claim),
            json!({
                "dispatch": {
                    "workspaceId": "workspace",
                    "triggerMessageId": "message",
                    "agentId": "default",
                    "threadId": "thread",
                    "state": "pending",
                    "attemptCount": 0,
                    "createdAtMs": 9,
                    "updatedAtMs": 9,
                },
                "run": {
                    "workspaceId": "workspace",
                    "runId": "run",
                    "agentId": "default",
                    "threadId": "thread",
                    "triggerMessageId": "message",
                    "command": "",
                    "startedAtMs": 10,
                    "failureHandled": false,
                },
                "chainDepth": 2,
            })
        );
    }

    #[test]
    fn ended_run_and_paused_thread_carry_their_outcomes() {
        let ended = AgentRunRecord {
            ended_at_ms: Some(12),
            exit_code: Some(0),
            failure_reason: Some("app-quit".to_owned()),
            log_path: Some("logs/run.log".to_owned()),
            ..run()
        };
        let value = run_json(&ended);
        assert_eq!(value["endedAtMs"], json!(12));
        assert_eq!(value["exitCode"], json!(0));
        assert_eq!(value["failureReason"], json!("app-quit"));
        assert_eq!(value["logPath"], json!("logs/run.log"));
        let pause = ThreadDispatchPause {
            workspace_id: "workspace".to_owned(),
            thread_id: "thread".to_owned(),
            paused: false,
            reason: None,
            updated_at_ms: 13,
        };
        assert_eq!(
            pause_json(&pause),
            json!({
                "workspaceId": "workspace",
                "threadId": "thread",
                "paused": false,
                "updatedAtMs": 13,
            })
        );
        let paused = ThreadDispatchPause {
            paused: true,
            reason: Some("owner".to_owned()),
            ..pause
        };
        assert_eq!(pause_json(&paused)["reason"], json!("owner"));
    }
}
