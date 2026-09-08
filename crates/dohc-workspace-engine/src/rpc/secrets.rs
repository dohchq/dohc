use crate::EngineService;
use crate::rpc::error::map_runtime;
use crate::rpc::error::wire;
use crate::rpc::history::MOMENTS_PAGE_BYTE_BUDGET;
use crate::rpc::reads::VersionPathParams;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validate_metadata_fields;
use crate::rpc::request::validated_origin;
use crate::rpc::versions::WorkspaceOnlyParams;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_domain::DomainError;
use dohc_engine_domain::SecretDelete;
use dohc_engine_domain::SecretDiskIntent;
use dohc_engine_domain::SecretMomentRecord;
use dohc_engine_domain::SecretWrite;
use dohc_engine_domain::VersionFileChangeStatus;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::RuntimeError;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsListParams {
    version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsWriteParams {
    workspace_id: String,
    version_id: String,
    path: String,
    text: String,
    origin: String,
    moment_id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsDeleteParams {
    workspace_id: String,
    version_id: String,
    path: String,
    origin: String,
    moment_id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsForkParams {
    workspace_id: String,
    from_version_id: String,
    to_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsMomentsListParams {
    workspace_id: String,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    before_moment_order: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsMomentsGetParams {
    workspace_id: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsCompareParams {
    workspace_id: String,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsApplyParams {
    workspace_id: String,
    path: String,
    source_version_id: String,
    target_version_id: String,
    moment_id: String,
    origin: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsRestoreParams {
    workspace_id: String,
    path: String,
    before_moment_id: String,
    moment_id: String,
    origin: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

pub(super) fn secret_moment_json(moment: &SecretMomentRecord) -> Value {
    json!({
        "id": moment.moment_id,
        "workspaceId": moment.workspace_id,
        "versionId": moment.version_id,
        "path": moment.path,
        "recordedAtMs": moment.recorded_at_ms,
        "operation": moment.operation.as_str(),
        "metadata": {
            "origin": moment.metadata_origin,
            "summary": moment.metadata_summary,
            "correlationId": moment.metadata_correlation_id,
        },
        "momentOrder": moment.moment_order,
        "protected": true,
    })
}

impl EngineService {
    pub(super) async fn secrets_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // Paged at the DOMAIN (keyset by path): a many-secret workspace
        // never loads every tip per request just for the RPC to discard
        // the overflow.
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let secrets = Self::read_under_ctx(
            &cancellation,
            "secrets.list",
            open.actor.list_secret_files_page(
                open.workspace_id,
                params.version_id,
                params.after_path.clone(),
                limit + 1,
            ),
        )
        .await?;
        let has_more = secrets.len() > limit;
        let secrets = &secrets[..secrets.len().min(limit)];
        // Metadata-only and keyset-paged (afterPath/nextAfterPath); the
        // byte budget is the second bound so no page can outgrow the
        // frame even when rows are string-heavy.
        let row_values: Vec<Value> = secrets
            .iter()
            .map(|stat| {
                json!({
                    "path": stat.path,
                    "byteLength": stat.byte_length,
                    "updatedAtMs": stat.updated_at_ms,
                    "latestMomentId": stat.latest_moment_id,
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = included < row_values.len();
        let next_after_path = (has_more || byte_truncated)
            .then(|| secrets[..included].last().map(|stat| stat.path.clone()))
            .flatten();
        Ok(json!({
            "secrets": row_values[..included].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    pub(super) async fn secrets_state_exists(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let exists = Self::read_under_ctx(
            &cancellation,
            "secrets.stateExists",
            open.actor.secret_state_exists(open.workspace_id),
        )
        .await?;
        Ok(json!(exists))
    }

    async fn load_or_create_secret_key(
        &self,
        cancellation: &OperationCancellation,
        open: &OpenWorkspace,
        operation: &'static str,
    ) -> Result<dohc_engine_crypto::SecretDataKey, WireError> {
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let loaded = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption(operation));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
        };
        if let Some(key) = loaded {
            return Ok(key);
        }

        let has_state = Self::read_under_ctx(
            cancellation,
            operation,
            open.actor.secret_state_exists(open.workspace_id.clone()),
        )
        .await?;
        if has_state {
            return Err(wire(ErrorCode::Internal, "key-corrupt"));
        }

        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::create_key_file(&key_root));
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => Err(cancellation.interruption(operation)),
            created = key_task => created
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error)))),
        }
    }

    pub(super) async fn secrets_write(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsWriteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = params.path.clone();
        let text = params.text;
        if text.len() > dohc_engine_domain::MAX_SECRET_FILE_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(Some(&params.origin))?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        // Prove the version reference and secret-floor routing keylessly before
        // any key-file load/mint. Invalid calls must remain side-effect-free.
        Self::read_under_ctx(
            &cancellation,
            "secrets.write (validate)",
            open.actor.secret_file_len(
                open.workspace_id.clone(),
                params.version_id.clone(),
                path.clone(),
            ),
        )
        .await?;
        let key = self
            .load_or_create_secret_key(&cancellation, &open, "secrets.write (key load)")
            .await?;
        let result = open
            .actor
            .write_secret_file(
                SecretWrite {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    text,
                    moment_id: params.moment_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    now_ms: now_ms()?,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                key,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "changed": result.changed,
            "moment": result.moment.as_ref().map(secret_moment_json),
        }))
    }

    pub(super) async fn secrets_delete(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsDeleteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = params.path.clone();
        let origin = validated_origin(Some(&params.origin))?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = open
            .actor
            .delete_secret_file(
                SecretDelete {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    moment_id: params.moment_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    now_ms: now_ms()?,
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "moment": moment.as_ref().map(secret_moment_json) }))
    }

    pub(super) async fn secrets_fork(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsForkParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        open.actor
            .fork_secret_version(
                open.workspace_id,
                params.from_version_id,
                params.to_version_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({}))
    }

    pub(super) async fn secrets_moments_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsMomentsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = params.path.clone();
        let cancellation = OperationCancellation::new(ctx);
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let mut page = Self::read_under_ctx(
            &cancellation,
            "secrets.moments.list",
            open.actor.list_secret_moments(
                open.workspace_id,
                params.version_id,
                path,
                params.before_moment_order,
                limit,
            ),
        )
        .await?;
        let rows: Vec<Value> = page.moments.iter().map(secret_moment_json).collect();
        let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !rows.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        if included < rows.len() {
            page.next_before_moment_order = page.moments[..included]
                .last()
                .map(|moment| moment.moment_order);
        }
        Ok(json!({
            "moments": rows[..included].to_vec(),
            "nextBeforeMomentOrder": page.next_before_moment_order,
        }))
    }

    pub(super) async fn secrets_moments_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsMomentsGetParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = Self::read_under_ctx(
            &cancellation,
            "secrets.moments.get",
            open.actor
                .get_secret_moment(open.workspace_id, params.moment_id),
        )
        .await?;
        Ok(moment.as_ref().map_or(Value::Null, secret_moment_json))
    }

    pub(super) async fn secrets_compare(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsCompareParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        // Validate both version references before key state can affect error
        // precedence. These one-row keyless probes never hydrate ciphertext.
        Self::read_under_ctx(
            &cancellation,
            "secrets.compare (source version)",
            open.actor.list_secret_files_page(
                open.workspace_id.clone(),
                params.source_version_id.clone(),
                None,
                1,
            ),
        )
        .await?;
        Self::read_under_ctx(
            &cancellation,
            "secrets.compare (target version)",
            open.actor.list_secret_files_page(
                open.workspace_id.clone(),
                params.target_version_id.clone(),
                None,
                1,
            ),
        )
        .await?;
        let has_state = Self::read_under_ctx(
            &cancellation,
            "secrets.compare",
            open.actor.secret_state_exists(open.workspace_id.clone()),
        )
        .await?;
        let key = if has_state {
            let key_root = open.root.clone();
            let key_task =
                tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
            let loaded = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption("secrets.compare (key load)"));
                }
                loaded = key_task => loaded
                    .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                    .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
            };
            Some(loaded.ok_or_else(|| wire(ErrorCode::Internal, "key-corrupt"))?)
        } else {
            None
        };
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let page = Self::read_under_ctx(
            &cancellation,
            "secrets.compare",
            open.actor.compare_secret_files(
                open.workspace_id,
                params.source_version_id,
                params.target_version_id,
                params.after_path,
                limit,
                key,
            ),
        )
        .await?;
        let rows: Vec<Value> = page
            .entries
            .iter()
            .map(|entry| {
                json!({
                    "path": entry.path,
                    "status": match entry.status {
                        VersionFileChangeStatus::Added => "added",
                        VersionFileChangeStatus::Modified => "modified",
                        VersionFileChangeStatus::Deleted => "deleted",
                    },
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !rows.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = included < rows.len();
        let next_after_path = if byte_truncated {
            page.entries[..included]
                .last()
                .map(|entry| entry.path.clone())
        } else {
            page.next_after_path
        };
        Ok(json!({
            "entries": rows[..included].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    pub(super) async fn secrets_apply(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsApplyParams = parse(params)?;
        // Secret-path gate UP front so the error surface is identical across
        // key states (a non-secret path refuses the same way with or without
        // a key on disk).
        if dohc_engine_files::policy::classify_engine_file_path(&params.path)
            != dohc_engine_files::policy::PathClassification::Secret
        {
            return Err(wire(ErrorCode::InvalidParams, "not-secret-path"));
        }
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let origin = validated_origin(Some(&params.origin))?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let path = params.path.clone();
        let cancellation = OperationCancellation::new(ctx);
        for (operation, version_id) in [
            ("secrets.apply (source version)", &params.source_version_id),
            ("secrets.apply (target version)", &params.target_version_id),
        ] {
            let validation = Self::read_under_ctx(
                &cancellation,
                operation,
                open.actor.list_secret_files_page(
                    open.workspace_id.clone(),
                    version_id.clone(),
                    None,
                    1,
                ),
            )
            .await;
            match validation {
                Ok(_) => {}
                Err(error) if error.message == "invalid-version" => {
                    return Err(wire(ErrorCode::InvalidParams, "invalid-version"));
                }
                Err(error) => return Err(error),
            }
        }
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let key = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("secrets.apply (key load)"));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
        };
        let Some(key) = key else {
            let has_state = Self::read_under_ctx(
                &cancellation,
                "secrets.apply (key state)",
                open.actor.secret_state_exists(open.workspace_id.clone()),
            )
            .await?;
            if has_state {
                return Err(wire(ErrorCode::Internal, "key-corrupt"));
            }
            return Ok(json!({ "changed": false, "moment": Value::Null }));
        };
        let result = open
            .actor
            .apply_secret_file(
                open.workspace_id,
                path,
                params.source_version_id,
                params.target_version_id,
                params.moment_id,
                origin,
                params.summary,
                params.correlation_id,
                now_ms()?,
                key,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "changed": result.changed,
            "moment": result.moment.as_ref().map(secret_moment_json),
        }))
    }

    pub(super) async fn secrets_restore(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsRestoreParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let origin = validated_origin(Some(&params.origin))?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let path = params.path.clone();
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .restore_secret_file(
                open.workspace_id,
                path,
                params.before_moment_id,
                params.moment_id,
                origin,
                params.summary,
                params.correlation_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "restored": result.restored,
            "restoredMomentId": result.restored_moment_id,
            "path": result.path,
        }))
    }

    /// The single authorized plaintext accessor over RPC (TS parity:
    /// `materializeSecretFile`). The key is loaded from the workspace root
    /// per call — the daemon holds no key custody — and a missing key with
    /// live secret state fails closed rather than returning nothing.
    pub(super) async fn secrets_materialize(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionPathParams = parse(params)?;
        // Normalize once and use the normalized spelling everywhere: the
        // policy stable-decodes percent disguises (%2eenv classifies as.
        // Env), and querying with the raw spelling would answer "absent
        // secret" for a real one. This also runs the fail-closed secret
        // gate up front, before any state-dependent branch, so the error
        // surface is identical across key states.
        if dohc_engine_files::policy::classify_engine_file_path(&params.path)
            != dohc_engine_files::policy::PathClassification::Secret
        {
            return Err(wire(ErrorCode::InvalidParams, "not a secret path"));
        }
        // Query verbatim: the domain stores the spelling the write
        // carried, and a path secrets.list returns must materialize
        // verbatim — rewriting to the normalized spelling would orphan
        // stored tips (the classification above still uses it, so the
        // gate is disguise-proof).
        let secret_path = params.path.clone();
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // Precedence stat (keyless): validates the secret path and the
        // version before any key work, so caller mistakes error
        // identically regardless of local key-file state — and an absent
        // secret answers null right here: no key material is needed to
        // say "nothing stored", and a stale malformed key file must not
        // turn that answer into an error. The in-band cap itself is
        // decided later, inside the decrypting actor turn.
        let stat = Self::read_under_ctx(
            &cancellation,
            "secrets.materialize",
            open.actor.secret_file_len(
                open.workspace_id.clone(),
                params.version_id.clone(),
                secret_path.clone(),
            ),
        )
        .await?;
        if stat.is_none() {
            return Ok(Value::Null);
        }
        // Blocking filesystem work stays off the tokio worker — and the
        // wait for it is cancellation/deadline-raced like every other
        // await on this surface (the blocking task finishes on its own;
        // only the caller's wait abandons).
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let key = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("secrets.materialize (key load)"));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "secret key unavailable"))?
                .map_err(|_| wire(ErrorCode::Internal, "secret key unavailable"))?,
        };
        let Some(key) = key else {
            // Path and version already validated above (gate + stat).
            // The state check: a workspace that never minted a key has no
            // secrets; one with secret rows and no key is
            // corrupt/misrestored state and fails closed.
            let has_state = Self::read_under_ctx(
                &cancellation,
                "secrets.materialize",
                open.actor.secret_state_exists(open.workspace_id.clone()),
            )
            .await?;
            if has_state {
                return Err(wire(ErrorCode::Internal, "secret key unavailable"));
            }
            return Ok(Value::Null);
        };
        // Key present and valid: the cap is decided IN the decrypting
        // actor turn — a secret growing after any earlier read cannot be
        // decrypted over-cap, and over-cap plaintext never exists.
        let secret = Self::read_under_ctx(
            &cancellation,
            "secrets.materialize",
            open.actor.materialize_secret_inband(
                open.workspace_id,
                params.version_id,
                secret_path,
                key,
                dohc_engine_domain::MAX_SECRET_FILE_BYTES,
            ),
        )
        .await?;
        Ok(match secret {
            None => Value::Null,
            Some(secret) => match secret.text {
                Some(text) => json!({ "text": text }),
                None => json!({
                    "text": Value::Null,
                    "byteLength": secret.byte_length,
                    "inbandLimitBytes": dohc_engine_domain::MAX_SECRET_FILE_BYTES,
                }),
            },
        })
    }
}
