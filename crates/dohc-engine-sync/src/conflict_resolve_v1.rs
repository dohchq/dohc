use std::collections::BTreeSet;

use dohc_engine_collab::{
    ContentKind, DocKey, LineageClaimStatus, SuccessorBase, SuccessorIdentity,
    SuccessorIdentityInput, SuccessorReplacement, fresh_successor_base,
};
use dohc_engine_domain::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictResolution, ConflictStatus,
    ResolveConflictKind, ResolveTextConflict, ResolveTextConflictResult, TextConflict,
    TextSnapshot, derive_capture_object_id, insert_text_conflict_if_absent,
    select_snapshot_by_path_in_tx,
};
use dohc_engine_files::{
    MAX_CANONICAL_WORKSPACE_PATH_BYTES, PathClassification,
    canonical_workspace_path_meets_shared_bounds, classify_engine_file_path_normalized,
    search_policy::SearchPolicySnapshot,
};
use dohc_engine_storage::{MAX_IDENTIFIER_BYTES, StorageError};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

use crate::{
    ConflictApplyResult, LeaseProbe, MAX_PAYLOAD_JSON_BYTES, MAX_WIRE_INTEGER, MomentApplyResult,
    ReplicationEnvelope, SyncError,
};

const FORMAT_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ConflictResolveEnvelopeContext<'a> {
    pub workspace_id: &'a str,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolveChoiceV1 {
    Current,
    Incoming,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolutionV1 {
    KeptCurrent,
    AppliedIncoming,
    AppliedMerged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeadContentKindV1 {
    Text,
    Binary,
}

impl HeadContentKindV1 {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Binary => "binary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PresentHeadV1 {
    pub path_ref: usize,
    pub object_id: String,
    pub latest_moment_id: String,
    pub content_kind: HeadContentKindV1,
    pub blob_sha256: String,
    pub byte_length: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeadV1 {
    Absent { path_ref: usize },
    Present(PresentHeadV1),
}

impl HeadV1 {
    pub const fn path_ref(&self) -> usize {
        match self {
            Self::Absent { path_ref } => *path_ref,
            Self::Present(head) => head.path_ref,
        }
    }

    pub const fn present(&self) -> Option<&PresentHeadV1> {
        match self {
            Self::Absent { .. } => None,
            Self::Present(head) => Some(head),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MetadataV1 {
    pub origin: String,
    pub summary: Option<String>,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentAuthorV1 {
    pub agent_id: String,
    pub on_behalf_of: String,
    pub agent_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectContextV1 {
    pub recorded_at_ms: i64,
    pub metadata: MetadataV1,
    pub author: Option<AgentAuthorV1>,
    pub current_object_created_at_ms: Option<i64>,
    pub result_object_created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectKindV1 {
    Delete,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectV1 {
    pub kind: EffectKindV1,
    pub moment_id: String,
    pub payload_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SuccessorContentKindV1 {
    Plaintext,
    Richdoc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SuccessorV1 {
    pub lineage_claim_id: String,
    pub epoch_tag: String,
    pub content_kind: SuccessorContentKindV1,
    pub result_sha256: String,
    pub update_blob_sha256: String,
    pub state_vector_blob_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LineageTransitionV1 {
    pub predecessor_claim_id: String,
    pub predecessor_state_vector_sha256: String,
    pub artifact_preimage_sha256: String,
    pub successor: Option<SuccessorV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConflictResolveV1 {
    pub workspace_id: String,
    pub conflict_id: String,
    pub chosen_from: ResolveChoiceV1,
    pub resolution: ResolutionV1,
    pub target_version_id: String,
    pub source_version_id: String,
    pub paths: Vec<String>,
    pub current: HeadV1,
    pub incoming: HeadV1,
    pub result: HeadV1,
    pub effect_context: EffectContextV1,
    pub effects: Vec<EffectV1>,
    pub lineage_transition: Option<LineageTransitionV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedConflictResolveV1 {
    pub payload: ConflictResolveV1,
    pub shadows: Vec<Value>,
    pub shadow_sha256s: Vec<String>,
    pub text_blob_sha256s: Vec<String>,
    pub binary_blob_sha256s: Vec<String>,
    pub ydoc_blob_sha256s: Vec<String>,
    pub encoded_payload_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BuiltConflictResolveV1 {
    pub value: Value,
    pub validated: ValidatedConflictResolveV1,
}

/// A local resolution carrier prepared against the exact pre-effect head.
/// Fields stay private so callers cannot separate its lineage CAS from the
/// validated carrier that names it.
pub struct PreparedLocalConflictResolveV1 {
    built: BuiltConflictResolveV1,
    pre_effect_moment_order: i64,
    lineage: LocalLineagePlan,
}

impl PreparedLocalConflictResolveV1 {
    /// Refuse before domain effects if either object named by this resolution
    /// is owned by a live editor session.
    pub fn ensure_no_live_ydoc_session(&self, leases: &dyn LeaseProbe) -> Result<(), SyncError> {
        ensure_no_live_ydoc_session(&self.built.validated.payload, leases)
    }
}

enum LocalLineagePlan {
    None,
    ExactSuccessor {
        key: DocKey,
        predecessor_claim_id: String,
        predecessor_state_vector_sha256: String,
        path: String,
        successor: SuccessorBase,
    },
    ExactArchive {
        key: DocKey,
        predecessor_claim_id: String,
        predecessor_state_vector_sha256: String,
        artifact_preimage_sha256: String,
        last_surfaced_projection_sha256: Option<String>,
    },
    UnclaimedText {
        key: DocKey,
        path: String,
        text: String,
    },
    UnclaimedBareRetire {
        key: DocKey,
    },
}

pub(crate) fn build_conflict_resolve_v1(
    mut payload: ConflictResolveV1,
) -> Result<BuiltConflictResolveV1, SyncError> {
    validate_bindings(&payload)?;
    for effect_index in 0..payload.effects.len() {
        let shadow = match payload.effects[effect_index].kind {
            EffectKindV1::Delete => {
                delete_shadow(&payload, &payload.effects[effect_index], effect_index)?
            }
            EffectKindV1::Write => {
                write_shadow(&payload, &payload.effects[effect_index], effect_index)?
            }
        };
        let canonical = crate::relay::canonical_json_bytes(&shadow)?;
        ensure_limit(
            "MAX_PAYLOAD_JSON_BYTES",
            MAX_PAYLOAD_JSON_BYTES,
            canonical.len(),
        )?;
        payload.effects[effect_index].payload_sha256 = dohc_engine_storage::hex_sha256(&canonical);
    }
    let value = payload_value(&payload);
    let validated = validate_conflict_resolve_v1(
        &value,
        ConflictResolveEnvelopeContext {
            workspace_id: &payload.workspace_id,
            recorded_at_ms: payload.effect_context.recorded_at_ms,
        },
    )?;
    Ok(BuiltConflictResolveV1 { value, validated })
}

pub(crate) fn validate_conflict_resolve_v1(
    value: &Value,
    envelope: ConflictResolveEnvelopeContext<'_>,
) -> Result<ValidatedConflictResolveV1, SyncError> {
    let encoded_payload_bytes = serde_json::to_vec(value)
        .map_err(|_| invalid("conflict.resolve v1 payload is not JSON"))?
        .len();
    ensure_limit(
        "MAX_PAYLOAD_JSON_BYTES",
        MAX_PAYLOAD_JSON_BYTES,
        encoded_payload_bytes,
    )?;
    let record = exact_object(
        value,
        &[
            "formatVersion",
            "workspaceId",
            "conflictId",
            "status",
            "chosenFrom",
            "resolution",
            "targetVersionId",
            "sourceVersionId",
            "paths",
            "transition",
            "effectContext",
            "effects",
            "lineageTransition",
        ],
        "conflict.resolve v1 payload has unknown or missing fields",
    )?;
    if wire_integer(field(record, "formatVersion")?)? != FORMAT_VERSION {
        return Err(invalid("conflict.resolve formatVersion must be 1"));
    }
    if string(field(record, "status")?)? != "resolved" {
        return Err(invalid("conflict.resolve status must be resolved"));
    }
    let workspace_id = identifier(field(record, "workspaceId")?)?;
    if workspace_id != envelope.workspace_id {
        return Err(invalid(
            "conflict.resolve workspaceId does not match its envelope",
        ));
    }
    let conflict_id = identifier(field(record, "conflictId")?)?;
    let chosen_from = choice(field(record, "chosenFrom")?)?;
    let resolution = resolution(field(record, "resolution")?)?;
    let target_version_id = identifier(field(record, "targetVersionId")?)?;
    let source_version_id = identifier(field(record, "sourceVersionId")?)?;
    let paths = parse_paths(field(record, "paths")?)?;
    let transition = exact_object(
        field(record, "transition")?,
        &["current", "incoming", "result"],
        "conflict.resolve transition has unknown or missing fields",
    )?;
    let current = parse_head(field(transition, "current")?, paths.len())?;
    let incoming = parse_head(field(transition, "incoming")?, paths.len())?;
    let result = parse_head(field(transition, "result")?, paths.len())?;
    let effect_context = parse_effect_context(field(record, "effectContext")?)?;
    if effect_context.recorded_at_ms != envelope.recorded_at_ms {
        return Err(invalid(
            "conflict.resolve effectContext.recordedAtMs does not match its envelope",
        ));
    }
    let effects = parse_effects(field(record, "effects")?)?;
    let lineage_transition = parse_lineage_transition(field(record, "lineageTransition")?)?;
    let payload = ConflictResolveV1 {
        workspace_id,
        conflict_id,
        chosen_from,
        resolution,
        target_version_id,
        source_version_id,
        paths,
        current,
        incoming,
        result,
        effect_context,
        effects,
        lineage_transition,
    };
    validate_bindings(&payload)?;

    let mut shadows = Vec::with_capacity(payload.effects.len());
    let mut shadow_sha256s = Vec::with_capacity(payload.effects.len());
    for (effect_index, effect) in payload.effects.iter().enumerate() {
        let shadow = match effect.kind {
            EffectKindV1::Delete => delete_shadow(&payload, effect, effect_index)?,
            EffectKindV1::Write => write_shadow(&payload, effect, effect_index)?,
        };
        let canonical = crate::relay::canonical_json_bytes(&shadow)?;
        ensure_limit(
            "MAX_PAYLOAD_JSON_BYTES",
            MAX_PAYLOAD_JSON_BYTES,
            canonical.len(),
        )?;
        let observed = dohc_engine_storage::hex_sha256(&canonical);
        if observed != effect.payload_sha256 {
            return Err(invalid(
                "conflict.resolve effect hash does not match its canonical moment shadow",
            ));
        }
        shadows.push(shadow);
        shadow_sha256s.push(observed);
    }

    let (text_blob_sha256s, binary_blob_sha256s, ydoc_blob_sha256s) = blob_roots(&payload);
    Ok(ValidatedConflictResolveV1 {
        payload,
        shadows,
        shadow_sha256s,
        text_blob_sha256s,
        binary_blob_sha256s,
        ydoc_blob_sha256s,
        encoded_payload_bytes,
    })
}

fn invalid(reason: &'static str) -> SyncError {
    SyncError::InvalidInput { reason }
}

fn ensure_limit(
    constraint: &'static str,
    limit_bytes: usize,
    observed_bytes: usize,
) -> Result<(), SyncError> {
    if observed_bytes > limit_bytes {
        return Err(SyncError::InputTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        });
    }
    Ok(())
}

fn exact_object<'a>(
    value: &'a Value,
    expected: &[&str],
    reason: &'static str,
) -> Result<&'a Map<String, Value>, SyncError> {
    let Some(record) = value.as_object() else {
        return Err(invalid(reason));
    };
    if record.len() != expected.len() || expected.iter().any(|key| !record.contains_key(*key)) {
        return Err(invalid(reason));
    }
    Ok(record)
}

fn field<'a>(record: &'a Map<String, Value>, key: &str) -> Result<&'a Value, SyncError> {
    record
        .get(key)
        .ok_or_else(|| invalid("conflict.resolve v1 payload is missing a required field"))
}

fn string(value: &Value) -> Result<&str, SyncError> {
    value
        .as_str()
        .ok_or_else(|| invalid("conflict.resolve v1 field must be a string"))
}

fn identifier(value: &Value) -> Result<String, SyncError> {
    let value = string(value)?;
    if value.is_empty() {
        return Err(invalid("conflict.resolve identifier must not be empty"));
    }
    ensure_limit("MAX_IDENTIFIER_BYTES", MAX_IDENTIFIER_BYTES, value.len())?;
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(invalid(
            "conflict.resolve identifier contains an ASCII control character",
        ));
    }
    Ok(value.to_owned())
}

fn sha256(value: &Value) -> Result<String, SyncError> {
    let value = string(value)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            "conflict.resolve SHA-256 must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(value.to_owned())
}

fn wire_integer(value: &Value) -> Result<i64, SyncError> {
    let parsed = if let Some(value) = value.as_i64() {
        value
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).map_err(|_| {
            invalid("conflict.resolve integer is outside the non-negative wire range")
        })?
    } else if let Some(value) = value.as_f64()
        && value.is_finite()
        && value.fract() == 0.0
        && value >= 0.0
        && value <= MAX_WIRE_INTEGER as f64
    {
        value as i64
    } else {
        return Err(invalid(
            "conflict.resolve integer must be a non-negative safe integer",
        ));
    };
    if !(0..=MAX_WIRE_INTEGER).contains(&parsed) {
        return Err(invalid(
            "conflict.resolve integer must be a non-negative safe integer",
        ));
    }
    Ok(parsed)
}

fn choice(value: &Value) -> Result<ResolveChoiceV1, SyncError> {
    match string(value)? {
        "current" => Ok(ResolveChoiceV1::Current),
        "incoming" => Ok(ResolveChoiceV1::Incoming),
        "merged" => Ok(ResolveChoiceV1::Merged),
        _ => Err(invalid("conflict.resolve chosenFrom is invalid")),
    }
}

fn resolution(value: &Value) -> Result<ResolutionV1, SyncError> {
    match string(value)? {
        "kept-current" => Ok(ResolutionV1::KeptCurrent),
        "applied-incoming" => Ok(ResolutionV1::AppliedIncoming),
        "applied-merged" => Ok(ResolutionV1::AppliedMerged),
        _ => Err(invalid("conflict.resolve resolution is invalid")),
    }
}

fn parse_paths(value: &Value) -> Result<Vec<String>, SyncError> {
    let Some(values) = value.as_array() else {
        return Err(invalid("conflict.resolve paths must be an array"));
    };
    if !(1..=2).contains(&values.len()) {
        return Err(invalid(
            "conflict.resolve paths must contain one or two entries",
        ));
    }
    let mut paths = Vec::with_capacity(values.len());
    for value in values {
        let path = string(value)?;
        if path.is_empty() {
            return Err(invalid("conflict.resolve path must not be empty"));
        }
        ensure_limit(
            "MAX_CANONICAL_WORKSPACE_PATH_BYTES",
            MAX_CANONICAL_WORKSPACE_PATH_BYTES,
            path.len(),
        )?;
        if !canonical_workspace_path_meets_shared_bounds(path) {
            return Err(invalid(
                "conflict.resolve path contains an ASCII control character",
            ));
        }
        let (classification, normalized) = classify_engine_file_path_normalized(path);
        if classification != PathClassification::Tracked || normalized.as_deref() != Some(path) {
            return Err(invalid(
                "conflict.resolve path is not a canonical tracked workspace path",
            ));
        }
        paths.push(path.to_owned());
    }
    if paths.iter().collect::<BTreeSet<_>>().len() != paths.len() {
        return Err(invalid("conflict.resolve paths must be distinct"));
    }
    Ok(paths)
}

fn path_ref(value: &Value, path_count: usize) -> Result<usize, SyncError> {
    let value = usize::try_from(wire_integer(value)?)
        .map_err(|_| invalid("conflict.resolve pathRef is outside the wire range"))?;
    if value >= path_count {
        return Err(invalid(
            "conflict.resolve pathRef does not reference the path table",
        ));
    }
    Ok(value)
}

fn parse_head(value: &Value, path_count: usize) -> Result<HeadV1, SyncError> {
    let Some(record) = value.as_object() else {
        return Err(invalid("conflict.resolve head must be an object"));
    };
    match record.get("present").and_then(Value::as_bool) {
        Some(false) => {
            let record = exact_object(
                value,
                &["present", "pathRef"],
                "conflict.resolve absent head has unknown or missing fields",
            )?;
            Ok(HeadV1::Absent {
                path_ref: path_ref(field(record, "pathRef")?, path_count)?,
            })
        }
        Some(true) => {
            let record = exact_object(
                value,
                &[
                    "present",
                    "pathRef",
                    "objectId",
                    "latestMomentId",
                    "contentKind",
                    "blobSha256",
                    "byteLength",
                    "updatedAtMs",
                ],
                "conflict.resolve present head has unknown or missing fields",
            )?;
            let content_kind = match string(field(record, "contentKind")?)? {
                "text" => HeadContentKindV1::Text,
                "binary" => HeadContentKindV1::Binary,
                _ => return Err(invalid("conflict.resolve head contentKind is invalid")),
            };
            Ok(HeadV1::Present(PresentHeadV1 {
                path_ref: path_ref(field(record, "pathRef")?, path_count)?,
                object_id: identifier(field(record, "objectId")?)?,
                latest_moment_id: identifier(field(record, "latestMomentId")?)?,
                content_kind,
                blob_sha256: sha256(field(record, "blobSha256")?)?,
                byte_length: wire_integer(field(record, "byteLength")?)?,
                updated_at_ms: wire_integer(field(record, "updatedAtMs")?)?,
            }))
        }
        None => Err(invalid(
            "conflict.resolve head present field must be a boolean",
        )),
    }
}

fn optional_bounded_text(
    value: &Value,
    constraint: &'static str,
    limit: usize,
) -> Result<Option<String>, SyncError> {
    if value.is_null() {
        return Ok(None);
    }
    let value = string(value)?;
    ensure_limit(constraint, limit, value.len())?;
    Ok(Some(value.to_owned()))
}

fn parse_metadata(value: &Value) -> Result<MetadataV1, SyncError> {
    let record = exact_object(
        value,
        &["origin", "summary", "correlationId"],
        "conflict.resolve metadata has unknown or missing fields",
    )?;
    let origin = string(field(record, "origin")?)?;
    if !matches!(
        origin,
        "api" | "local-file" | "restore" | "sync" | "unknown"
    ) {
        return Err(invalid("conflict.resolve metadata origin is invalid"));
    }
    Ok(MetadataV1 {
        origin: origin.to_owned(),
        summary: optional_bounded_text(
            field(record, "summary")?,
            "MAX_METADATA_FIELD_BYTES",
            dohc_engine_domain::MAX_METADATA_FIELD_BYTES,
        )?,
        correlation_id: optional_bounded_text(
            field(record, "correlationId")?,
            "MAX_METADATA_FIELD_BYTES",
            dohc_engine_domain::MAX_METADATA_FIELD_BYTES,
        )?,
    })
}

fn author_field(value: &Value) -> Result<String, SyncError> {
    let value = string(value)?;
    if value.is_empty() {
        return Err(invalid("conflict.resolve author field must not be empty"));
    }
    ensure_limit(
        "MAX_AUTHOR_FIELD_BYTES",
        dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES,
        value.len(),
    )?;
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(invalid(
            "conflict.resolve author field contains an ASCII control character",
        ));
    }
    Ok(value.to_owned())
}

fn parse_author(value: &Value) -> Result<Option<AgentAuthorV1>, SyncError> {
    if value.is_null() {
        return Ok(None);
    }
    let record = exact_object(
        value,
        &["kind", "agentId", "onBehalfOf", "agentRunId"],
        "conflict.resolve author has unknown or missing fields",
    )?;
    if string(field(record, "kind")?)? != "agent" {
        return Err(invalid("conflict.resolve author kind must be agent"));
    }
    Ok(Some(AgentAuthorV1 {
        agent_id: author_field(field(record, "agentId")?)?,
        on_behalf_of: author_field(field(record, "onBehalfOf")?)?,
        agent_run_id: if field(record, "agentRunId")?.is_null() {
            None
        } else {
            Some(author_field(field(record, "agentRunId")?)?)
        },
    }))
}

fn nullable_wire_integer(value: &Value) -> Result<Option<i64>, SyncError> {
    if value.is_null() {
        Ok(None)
    } else {
        wire_integer(value).map(Some)
    }
}

fn parse_effect_context(value: &Value) -> Result<EffectContextV1, SyncError> {
    let record = exact_object(
        value,
        &[
            "recordedAtMs",
            "metadata",
            "author",
            "currentObjectCreatedAtMs",
            "resultObjectCreatedAtMs",
        ],
        "conflict.resolve effectContext has unknown or missing fields",
    )?;
    Ok(EffectContextV1 {
        recorded_at_ms: wire_integer(field(record, "recordedAtMs")?)?,
        metadata: parse_metadata(field(record, "metadata")?)?,
        author: parse_author(field(record, "author")?)?,
        current_object_created_at_ms: nullable_wire_integer(field(
            record,
            "currentObjectCreatedAtMs",
        )?)?,
        result_object_created_at_ms: nullable_wire_integer(field(
            record,
            "resultObjectCreatedAtMs",
        )?)?,
    })
}

fn parse_effects(value: &Value) -> Result<Vec<EffectV1>, SyncError> {
    let Some(values) = value.as_array() else {
        return Err(invalid("conflict.resolve effects must be an array"));
    };
    if values.len() > 2 {
        return Err(invalid(
            "conflict.resolve effects must contain at most two entries",
        ));
    }
    values
        .iter()
        .map(|value| {
            let record = exact_object(
                value,
                &["kind", "momentId", "payloadSha256"],
                "conflict.resolve effect has unknown or missing fields",
            )?;
            let kind = match string(field(record, "kind")?)? {
                "delete" => EffectKindV1::Delete,
                "write" => EffectKindV1::Write,
                _ => return Err(invalid("conflict.resolve effect kind is invalid")),
            };
            Ok(EffectV1 {
                kind,
                moment_id: identifier(field(record, "momentId")?)?,
                payload_sha256: sha256(field(record, "payloadSha256")?)?,
            })
        })
        .collect()
}

fn parse_successor(value: &Value) -> Result<Option<SuccessorV1>, SyncError> {
    if value.is_null() {
        return Ok(None);
    }
    let record = exact_object(
        value,
        &[
            "lineageClaimId",
            "epochTag",
            "contentKind",
            "resultSha256",
            "updateBlobSha256",
            "stateVectorBlobSha256",
        ],
        "conflict.resolve successor has unknown or missing fields",
    )?;
    let content_kind = match string(field(record, "contentKind")?)? {
        "plaintext" => SuccessorContentKindV1::Plaintext,
        "richdoc" => SuccessorContentKindV1::Richdoc,
        _ => return Err(invalid("conflict.resolve successor contentKind is invalid")),
    };
    Ok(Some(SuccessorV1 {
        lineage_claim_id: sha256(field(record, "lineageClaimId")?)?,
        epoch_tag: sha256(field(record, "epochTag")?)?,
        content_kind,
        result_sha256: sha256(field(record, "resultSha256")?)?,
        update_blob_sha256: sha256(field(record, "updateBlobSha256")?)?,
        state_vector_blob_sha256: sha256(field(record, "stateVectorBlobSha256")?)?,
    }))
}

fn parse_lineage_transition(value: &Value) -> Result<Option<LineageTransitionV1>, SyncError> {
    if value.is_null() {
        return Ok(None);
    }
    let record = exact_object(
        value,
        &[
            "predecessorClaimId",
            "predecessorStateVectorSha256",
            "artifactPreimageSha256",
            "successor",
        ],
        "conflict.resolve lineageTransition has unknown or missing fields",
    )?;
    Ok(Some(LineageTransitionV1 {
        predecessor_claim_id: sha256(field(record, "predecessorClaimId")?)?,
        predecessor_state_vector_sha256: sha256(field(record, "predecessorStateVectorSha256")?)?,
        artifact_preimage_sha256: sha256(field(record, "artifactPreimageSha256")?)?,
        successor: parse_successor(field(record, "successor")?)?,
    }))
}

fn same_projected_content(left: &HeadV1, right: &HeadV1) -> bool {
    match (left, right) {
        (HeadV1::Absent { .. }, HeadV1::Absent { .. }) => true,
        (HeadV1::Present(left), HeadV1::Present(right)) => {
            left.path_ref == right.path_ref
                && left.content_kind == right.content_kind
                && left.blob_sha256 == right.blob_sha256
                && left.byte_length == right.byte_length
        }
        _ => false,
    }
}

fn validate_bindings(payload: &ConflictResolveV1) -> Result<(), SyncError> {
    let pair_matches = matches!(
        (payload.chosen_from, payload.resolution),
        (ResolveChoiceV1::Current, ResolutionV1::KeptCurrent)
            | (ResolveChoiceV1::Incoming, ResolutionV1::AppliedIncoming)
            | (ResolveChoiceV1::Merged, ResolutionV1::AppliedMerged)
    );
    if !pair_matches {
        return Err(invalid(
            "conflict.resolve chosenFrom and resolution do not match",
        ));
    }
    if payload.current.path_ref() != 0 {
        return Err(invalid(
            "conflict.resolve current head must reference paths[0]",
        ));
    }
    let used_paths = [
        payload.current.path_ref(),
        payload.incoming.path_ref(),
        payload.result.path_ref(),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    if used_paths.len() != payload.paths.len() {
        return Err(invalid("conflict.resolve path table has an unused entry"));
    }
    if payload.current.present().is_some()
        != payload
            .effect_context
            .current_object_created_at_ms
            .is_some()
    {
        return Err(invalid(
            "conflict.resolve current creation time does not match its head",
        ));
    }
    if payload.result.present().is_some()
        != payload.effect_context.result_object_created_at_ms.is_some()
    {
        return Err(invalid(
            "conflict.resolve result creation time does not match its head",
        ));
    }
    if let (Some(current), Some(result)) = (payload.current.present(), payload.result.present())
        && current.object_id == result.object_id
        && payload.effect_context.current_object_created_at_ms
            != payload.effect_context.result_object_created_at_ms
    {
        return Err(invalid(
            "conflict.resolve gives one object conflicting creation times",
        ));
    }
    match payload.resolution {
        ResolutionV1::KeptCurrent if payload.current != payload.result => {
            return Err(invalid(
                "conflict.resolve kept-current result does not equal current",
            ));
        }
        ResolutionV1::AppliedIncoming
            if !same_projected_content(&payload.incoming, &payload.result) =>
        {
            return Err(invalid(
                "conflict.resolve applied-incoming result does not match incoming content",
            ));
        }
        ResolutionV1::AppliedMerged => match payload.result.present() {
            Some(result)
                if result.content_kind == HeadContentKindV1::Text && result.path_ref == 0 => {}
            _ => {
                return Err(invalid(
                    "conflict.resolve applied-merged requires text on the current path",
                ));
            }
        },
        _ => {}
    }

    let expected_effects = expected_effect_kinds(&payload.current, &payload.result);
    if payload.effects.len() != expected_effects.len()
        || payload
            .effects
            .iter()
            .zip(expected_effects)
            .any(|(effect, expected)| effect.kind != *expected)
    {
        return Err(invalid(
            "conflict.resolve effects do not match the ordered state transition",
        ));
    }
    if payload
        .effects
        .iter()
        .map(|effect| effect.moment_id.as_str())
        .collect::<BTreeSet<_>>()
        .len()
        != payload.effects.len()
    {
        return Err(invalid("conflict.resolve effect moment IDs must be unique"));
    }
    if let Some(write) = payload
        .effects
        .iter()
        .find(|effect| effect.kind == EffectKindV1::Write)
    {
        let Some(result) = payload.result.present() else {
            return Err(invalid(
                "conflict.resolve write effect requires a present result",
            ));
        };
        if result.latest_moment_id != write.moment_id {
            return Err(invalid(
                "conflict.resolve write effect does not match result latestMomentId",
            ));
        }
        if result.updated_at_ms != payload.effect_context.recorded_at_ms {
            return Err(invalid(
                "conflict.resolve write result timestamp does not match effectContext",
            ));
        }
    }

    if let Some(lineage) = payload.lineage_transition.as_ref() {
        let Some(current) = payload.current.present() else {
            return Err(invalid(
                "conflict.resolve lineage transition requires a present current head",
            ));
        };
        if lineage.artifact_preimage_sha256 != current.blob_sha256 {
            return Err(invalid(
                "conflict.resolve lineage artifact preimage does not match current",
            ));
        }
        match lineage.successor.as_ref() {
            Some(successor) => {
                let Some(result) = payload.result.present() else {
                    return Err(invalid(
                        "conflict.resolve successor requires a present text result",
                    ));
                };
                if current.content_kind != HeadContentKindV1::Text
                    || result.content_kind != HeadContentKindV1::Text
                    || current.object_id != result.object_id
                {
                    return Err(invalid(
                        "conflict.resolve successor must replace the same text object",
                    ));
                }
                if successor.lineage_claim_id != successor.update_blob_sha256 {
                    return Err(invalid(
                        "conflict.resolve successor claim does not equal its update blob",
                    ));
                }
                if successor.result_sha256 != result.blob_sha256 {
                    return Err(invalid(
                        "conflict.resolve successor result does not match the result head",
                    ));
                }
            }
            None if payload.result.present().is_some_and(|head| {
                head.content_kind == HeadContentKindV1::Text && head.object_id == current.object_id
            }) =>
            {
                return Err(invalid(
                    "conflict.resolve text lineage transition requires a successor",
                ));
            }
            None => {}
        }
    }
    Ok(())
}

fn metadata_value(metadata: &MetadataV1) -> Value {
    json!({
        "origin": metadata.origin,
        "summary": metadata.summary,
        "correlationId": metadata.correlation_id,
    })
}

fn wire_author_value(author: Option<&AgentAuthorV1>) -> Value {
    let Some(author) = author else {
        return Value::Null;
    };
    json!({
        "kind": "agent",
        "agentId": author.agent_id,
        "onBehalfOf": author.on_behalf_of,
        "agentRunId": author.agent_run_id,
    })
}

fn author_value(author: Option<&AgentAuthorV1>) -> Value {
    let Some(author) = author else {
        return Value::Null;
    };
    let mut value = json!({
        "kind": "agent",
        "agentId": author.agent_id,
        "onBehalfOf": author.on_behalf_of,
    });
    if let Some(agent_run_id) = author.agent_run_id.as_ref() {
        value
            .as_object_mut()
            .expect("agent author is an object")
            .insert("agentRunId".to_owned(), json!(agent_run_id));
    }
    value
}

fn delete_shadow(
    payload: &ConflictResolveV1,
    effect: &EffectV1,
    effect_index: usize,
) -> Result<Value, SyncError> {
    let current = payload
        .current
        .present()
        .ok_or_else(|| invalid("conflict.resolve delete effect requires a present current head"))?;
    let created_at_ms = payload
        .effect_context
        .current_object_created_at_ms
        .ok_or_else(|| invalid("conflict.resolve delete effect has no object creation time"))?;
    let path = &payload.paths[current.path_ref];
    Ok(json!({
        "conflictId": payload.conflict_id,
        "conflictEffectIndex": effect_index,
        "momentId": effect.moment_id,
        "versionId": payload.target_version_id,
        "objectId": current.object_id,
        "objectCreatedAtMs": created_at_ms,
        "path": path,
        "recordedAtMs": payload.effect_context.recorded_at_ms,
        "operation": "delete",
        "payloadBeforeBlobSha256": current.blob_sha256,
        "payloadBeforePath": path,
        "payloadAfterBlobSha256": current.blob_sha256,
        "payloadAfterPath": path,
        "payloadBeforeContentKind": current.content_kind.as_str(),
        "payloadBeforeByteLength": current.byte_length,
        "payloadAfterContentKind": current.content_kind.as_str(),
        "payloadAfterByteLength": current.byte_length,
        "metadata": metadata_value(&payload.effect_context.metadata),
        "author": author_value(payload.effect_context.author.as_ref()),
        "beforePresent": "present",
        "beforeObjectId": current.object_id,
        "beforeVersionId": payload.target_version_id,
        "beforePath": path,
        "beforeBlobSha256": current.blob_sha256,
        "beforeContentKind": current.content_kind.as_str(),
        "beforeByteLength": current.byte_length,
        "beforeUpdatedAtMs": current.updated_at_ms,
        "beforeLatestMomentId": current.latest_moment_id,
        "beforeMetadata": Value::Null,
    }))
}

fn write_shadow(
    payload: &ConflictResolveV1,
    effect: &EffectV1,
    effect_index: usize,
) -> Result<Value, SyncError> {
    let result = payload
        .result
        .present()
        .ok_or_else(|| invalid("conflict.resolve write effect requires a present result head"))?;
    let created_at_ms = payload
        .effect_context
        .result_object_created_at_ms
        .ok_or_else(|| invalid("conflict.resolve write effect has no object creation time"))?;
    let path = &payload.paths[result.path_ref];
    let before = payload
        .current
        .present()
        .filter(|current| current.path_ref == result.path_ref);
    Ok(json!({
        "conflictId": payload.conflict_id,
        "conflictEffectIndex": effect_index,
        "momentId": effect.moment_id,
        "versionId": payload.target_version_id,
        "objectId": result.object_id,
        "objectCreatedAtMs": created_at_ms,
        "path": path,
        "recordedAtMs": payload.effect_context.recorded_at_ms,
        "operation": "write",
        "payloadBeforeBlobSha256": before.map(|head| head.blob_sha256.as_str()),
        "payloadBeforePath": before.map(|head| payload.paths[head.path_ref].as_str()),
        "payloadAfterBlobSha256": result.blob_sha256,
        "payloadAfterPath": path,
        "payloadBeforeContentKind": before.map(|head| head.content_kind.as_str()),
        "payloadBeforeByteLength": before.map(|head| head.byte_length),
        "payloadAfterContentKind": result.content_kind.as_str(),
        "payloadAfterByteLength": result.byte_length,
        "metadata": metadata_value(&payload.effect_context.metadata),
        "author": author_value(payload.effect_context.author.as_ref()),
        "beforePresent": if before.is_some() { "present" } else { "null" },
        "beforeObjectId": before.map(|head| head.object_id.as_str()),
        "beforeVersionId": before.map(|_| payload.target_version_id.as_str()),
        "beforePath": before.map(|head| payload.paths[head.path_ref].as_str()),
        "beforeBlobSha256": before.map(|head| head.blob_sha256.as_str()),
        "beforeContentKind": before.map(|head| head.content_kind.as_str()),
        "beforeByteLength": before.map(|head| head.byte_length),
        "beforeUpdatedAtMs": before.map(|head| head.updated_at_ms),
        "beforeLatestMomentId": before.map(|head| head.latest_moment_id.as_str()),
        "beforeMetadata": Value::Null,
    }))
}

fn blob_roots(payload: &ConflictResolveV1) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut text = BTreeSet::new();
    let mut binary = BTreeSet::new();
    let mut ydoc = BTreeSet::new();
    for head in [&payload.current, &payload.incoming, &payload.result]
        .into_iter()
        .filter_map(HeadV1::present)
    {
        match head.content_kind {
            HeadContentKindV1::Text => {
                text.insert(head.blob_sha256.clone());
            }
            HeadContentKindV1::Binary => {
                binary.insert(head.blob_sha256.clone());
            }
        }
    }
    if let Some(successor) = payload
        .lineage_transition
        .as_ref()
        .and_then(|transition| transition.successor.as_ref())
    {
        ydoc.insert(successor.update_blob_sha256.clone());
        ydoc.insert(successor.state_vector_blob_sha256.clone());
    }
    (
        text.into_iter().collect(),
        binary.into_iter().collect(),
        ydoc.into_iter().collect(),
    )
}

fn head_value(head: &HeadV1) -> Value {
    match head {
        HeadV1::Absent { path_ref } => json!({
            "present": false,
            "pathRef": path_ref,
        }),
        HeadV1::Present(head) => json!({
            "present": true,
            "pathRef": head.path_ref,
            "objectId": head.object_id,
            "latestMomentId": head.latest_moment_id,
            "contentKind": head.content_kind.as_str(),
            "blobSha256": head.blob_sha256,
            "byteLength": head.byte_length,
            "updatedAtMs": head.updated_at_ms,
        }),
    }
}

fn lineage_transition_value(transition: Option<&LineageTransitionV1>) -> Value {
    let Some(transition) = transition else {
        return Value::Null;
    };
    let successor = transition
        .successor
        .as_ref()
        .map_or(Value::Null, |successor| {
            json!({
                "lineageClaimId": successor.lineage_claim_id,
                "epochTag": successor.epoch_tag,
                "contentKind": match successor.content_kind {
                    SuccessorContentKindV1::Plaintext => "plaintext",
                    SuccessorContentKindV1::Richdoc => "richdoc",
                },
                "resultSha256": successor.result_sha256,
                "updateBlobSha256": successor.update_blob_sha256,
                "stateVectorBlobSha256": successor.state_vector_blob_sha256,
            })
        });
    json!({
        "predecessorClaimId": transition.predecessor_claim_id,
        "predecessorStateVectorSha256": transition.predecessor_state_vector_sha256,
        "artifactPreimageSha256": transition.artifact_preimage_sha256,
        "successor": successor,
    })
}

fn payload_value(payload: &ConflictResolveV1) -> Value {
    let chosen_from = match payload.chosen_from {
        ResolveChoiceV1::Current => "current",
        ResolveChoiceV1::Incoming => "incoming",
        ResolveChoiceV1::Merged => "merged",
    };
    let resolution = match payload.resolution {
        ResolutionV1::KeptCurrent => "kept-current",
        ResolutionV1::AppliedIncoming => "applied-incoming",
        ResolutionV1::AppliedMerged => "applied-merged",
    };
    let effects = payload
        .effects
        .iter()
        .map(|effect| {
            json!({
                "kind": match effect.kind {
                    EffectKindV1::Delete => "delete",
                    EffectKindV1::Write => "write",
                },
                "momentId": effect.moment_id,
                "payloadSha256": effect.payload_sha256,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "formatVersion": FORMAT_VERSION,
        "workspaceId": payload.workspace_id,
        "conflictId": payload.conflict_id,
        "status": "resolved",
        "chosenFrom": chosen_from,
        "resolution": resolution,
        "targetVersionId": payload.target_version_id,
        "sourceVersionId": payload.source_version_id,
        "paths": payload.paths,
        "transition": {
            "current": head_value(&payload.current),
            "incoming": head_value(&payload.incoming),
            "result": head_value(&payload.result),
        },
        "effectContext": {
            "recordedAtMs": payload.effect_context.recorded_at_ms,
            "metadata": metadata_value(&payload.effect_context.metadata),
            "author": wire_author_value(payload.effect_context.author.as_ref()),
            "currentObjectCreatedAtMs": payload.effect_context.current_object_created_at_ms,
            "resultObjectCreatedAtMs": payload.effect_context.result_object_created_at_ms,
        },
        "effects": effects,
        "lineageTransition": lineage_transition_value(payload.lineage_transition.as_ref()),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportedHeadDisposition {
    ExactCurrent,
    AlreadyResult,
    Diverged,
}

pub(crate) fn apply_imported_conflict_resolve_v1_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    search_policy: Option<&SearchPolicySnapshot>,
    leases: &dyn LeaseProbe,
) -> Result<ConflictApplyResult, SyncError> {
    let validated = validate_conflict_resolve_v1(
        &envelope.payload,
        ConflictResolveEnvelopeContext {
            workspace_id: &envelope.workspace_id,
            recorded_at_ms: envelope.recorded_at_ms,
        },
    )?;
    require_imported_roots(tx, &validated)?;
    let payload = &validated.payload;
    let (mut disposition, live) = classify_imported_head(tx, payload)?;

    let key = payload
        .current
        .present()
        .map(|current| {
            DocKey::new(
                &payload.workspace_id,
                &payload.target_version_id,
                &current.object_id,
            )
            .map_err(|_| SyncError::InvalidInput {
                reason: "conflict.resolve Y.Doc coordinates are invalid",
            })
        })
        .transpose()?;
    ensure_no_live_ydoc_session(payload, leases)?;
    if disposition != ImportedHeadDisposition::Diverged
        && payload.lineage_transition.is_none()
        && !unbound_receiver_lineages_match_reviewed_sides(tx, payload)?
    {
        disposition = ImportedHeadDisposition::Diverged;
    }
    if disposition != ImportedHeadDisposition::Diverged {
        preflight_imported_lineage(tx, payload, key.as_ref(), disposition)?;
    }

    let mut materialization_changes = Vec::new();
    match disposition {
        ImportedHeadDisposition::ExactCurrent => {
            for shadow in &validated.shadows {
                let result = crate::moment_apply::apply_conflict_parent_shadow_in_tx(
                    tx,
                    envelope,
                    shadow,
                    search_policy,
                )?;
                materialization_changes.extend(result.materialization_changes);
            }
            commit_imported_lineage(tx, payload, key.as_ref(), envelope.recorded_at_ms)?;
            close_imported_conflict(tx, payload)?;
        }
        ImportedHeadDisposition::AlreadyResult => {
            for shadow in &validated.shadows {
                crate::moment_apply::record_conflict_parent_shadow_in_tx(
                    tx,
                    &payload.workspace_id,
                    shadow,
                )?;
            }
            if payload.lineage_transition.is_none() {
                reconcile_unbound_receiver_lineages(tx, payload, envelope.recorded_at_ms)?;
            }
            close_imported_conflict(tx, payload)?;
        }
        ImportedHeadDisposition::Diverged => {
            for shadow in &validated.shadows {
                crate::moment_apply::record_conflict_parent_shadow_in_tx(
                    tx,
                    &payload.workspace_id,
                    shadow,
                )?;
            }
            let (review_conflict_id, inserted) = open_divergent_result_review(tx, payload, &live)?;
            archive_conflicting_successor(
                tx,
                payload,
                &review_conflict_id,
                envelope.recorded_at_ms,
            )?;
            return Ok(ConflictApplyResult {
                conflict_id: review_conflict_id,
                inserted: Some(inserted),
                matched: false,
            });
        }
    }
    if !materialization_changes.is_empty() {
        crate::moment_apply::record_materialization_changes(
            tx,
            envelope,
            &materialization_changes,
        )?;
    }
    Ok(ConflictApplyResult {
        conflict_id: payload.conflict_id.clone(),
        inserted: None,
        matched: true,
    })
}

fn conflict_resolve_ydoc_keys(payload: &ConflictResolveV1) -> Result<Vec<DocKey>, SyncError> {
    let mut keys = Vec::with_capacity(2);
    if payload.current.present().is_none() {
        keys.push(
            DocKey::new(
                &payload.workspace_id,
                &payload.target_version_id,
                derive_capture_object_id(
                    &payload.workspace_id,
                    &payload.target_version_id,
                    &payload.paths[payload.current.path_ref()],
                ),
            )
            .map_err(|_| SyncError::InvalidInput {
                reason: "conflict.resolve Y.Doc coordinates are invalid",
            })?,
        );
    }
    for head in [&payload.current, &payload.result] {
        let Some(head) = head.present() else {
            continue;
        };
        let key = DocKey::new(
            &payload.workspace_id,
            &payload.target_version_id,
            &head.object_id,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "conflict.resolve Y.Doc coordinates are invalid",
        })?;
        if !keys.iter().any(|candidate| candidate == &key) {
            keys.push(key);
        }
    }
    let result_path_key = DocKey::new(
        &payload.workspace_id,
        &payload.target_version_id,
        derive_capture_object_id(
            &payload.workspace_id,
            &payload.target_version_id,
            &payload.paths[payload.result.path_ref()],
        ),
    )
    .map_err(|_| SyncError::InvalidInput {
        reason: "conflict.resolve Y.Doc coordinates are invalid",
    })?;
    if !keys.iter().any(|candidate| candidate == &result_path_key) {
        keys.push(result_path_key);
    }
    Ok(keys)
}

fn ensure_no_live_ydoc_session(
    payload: &ConflictResolveV1,
    leases: &dyn LeaseProbe,
) -> Result<(), SyncError> {
    if conflict_resolve_ydoc_keys(payload)?
        .iter()
        .any(|key| leases.is_live(key))
    {
        return Err(SyncError::RetryableState {
            reason: "ydoc-session-live",
        });
    }
    Ok(())
}

fn unbound_receiver_lineages_match_reviewed_sides(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
) -> Result<bool, SyncError> {
    for key in conflict_resolve_ydoc_keys(payload)? {
        let Some(lineage) = crate::ydoc_apply::complete_ydoc_projection_in_tx(tx, &key)? else {
            continue;
        };
        if lineage.claim_status.has_claimed_base() {
            return Ok(false);
        }
        let Some(projection) = lineage.markdown else {
            continue;
        };
        let projection_sha256 = dohc_engine_storage::hex_sha256(projection.as_bytes());
        let matches_reviewed_side = [&payload.current, &payload.result].iter().any(|head| {
            head.present().is_some_and(|head| {
                head.object_id == key.object_id
                    && head.content_kind == HeadContentKindV1::Text
                    && head.blob_sha256 == projection_sha256
            })
        });
        if !matches_reviewed_side {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn verify_imported_conflict_effect_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<MomentApplyResult, SyncError> {
    let owner = crate::moment_apply::validate_tagged_shadow_payload(&envelope.payload)
        .map_err(|_| SyncError::CoordinateDiverged)?;
    let offset = i64::try_from(owner.effect_index)
        .ok()
        .and_then(|index| index.checked_add(1))
        .ok_or(SyncError::CoordinateDiverged)?;
    let parent_seq = envelope
        .origin_seq
        .checked_sub(offset)
        .ok_or(SyncError::CoordinateDiverged)?;
    let parent: Option<(String, i64)> = tx
        .query_row(
            "SELECT payload_json,recorded_at_ms FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 \
               AND op_kind='conflict.resolve' AND imported=1 \
               AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals r \
                 WHERE r.workspace_id=?1 AND r.origin_id=?2 AND r.origin_seq=?3)",
            params![envelope.workspace_id, envelope.origin_id, parent_seq],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((parent_json, parent_recorded_at_ms)) = parent else {
        return Err(SyncError::CoordinateDiverged);
    };
    let parent_value: Value =
        serde_json::from_str(&parent_json).map_err(|_| SyncError::CoordinateDiverged)?;
    let parent = validate_conflict_resolve_v1(
        &parent_value,
        ConflictResolveEnvelopeContext {
            workspace_id: &envelope.workspace_id,
            recorded_at_ms: parent_recorded_at_ms,
        },
    )?;
    if parent.payload.conflict_id != owner.conflict_id || owner.effect_index >= parent.shadows.len()
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let expected = crate::relay::canonical_json_bytes(&parent.shadows[owner.effect_index])?;
    let observed = crate::relay::canonical_json_bytes(&envelope.payload)?;
    if expected != observed
        || dohc_engine_storage::hex_sha256(&observed) != parent.shadow_sha256s[owner.effect_index]
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let moment_id = parent.payload.effects[owner.effect_index]
        .moment_id
        .as_str();
    let recorded: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2)",
            params![envelope.workspace_id, moment_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !recorded {
        return Err(corrupt_local(
            "accepted conflict parent has no owned moment history",
        ));
    }
    Ok(MomentApplyResult {
        conflicts_opened: 0,
        materialization_changes: Vec::new(),
    })
}

fn require_imported_roots(
    tx: &Transaction<'_>,
    validated: &ValidatedConflictResolveV1,
) -> Result<(), SyncError> {
    for sha in &validated.text_blob_sha256s {
        let text: Option<String> = tx
            .query_row("SELECT text FROM blobs WHERE sha256=?1", [sha], |row| {
                row.get(0)
            })
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some(text) = text else {
            return Err(SyncError::BlobInvalid);
        };
        if dohc_engine_storage::hex_sha256(text.as_bytes()) != *sha {
            return Err(SyncError::BlobInvalid);
        }
    }
    for sha in validated
        .binary_blob_sha256s
        .iter()
        .chain(&validated.ydoc_blob_sha256s)
    {
        let bytes: Option<Vec<u8>> = tx
            .query_row(
                "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                [sha],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some(bytes) = bytes else {
            return Err(SyncError::BlobInvalid);
        };
        if dohc_engine_storage::hex_sha256(&bytes) != *sha {
            return Err(SyncError::BlobInvalid);
        }
    }
    Ok(())
}

fn classify_imported_head(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
) -> Result<(ImportedHeadDisposition, HeadV1), SyncError> {
    let current_path_ref = payload.current.path_ref();
    let current_live = imported_live_head(tx, payload, current_path_ref)?;
    if current_live == payload.current {
        return Ok((ImportedHeadDisposition::ExactCurrent, current_live));
    }
    let result_path_ref = payload.result.path_ref();
    if result_path_ref == current_path_ref {
        return Ok((
            if current_live == payload.result {
                ImportedHeadDisposition::AlreadyResult
            } else {
                ImportedHeadDisposition::Diverged
            },
            current_live,
        ));
    }
    if current_live.present().is_some() {
        return Ok((ImportedHeadDisposition::Diverged, current_live));
    }
    let result_live = imported_live_head(tx, payload, result_path_ref)?;
    Ok((
        if result_live == payload.result {
            ImportedHeadDisposition::AlreadyResult
        } else {
            ImportedHeadDisposition::Diverged
        },
        if result_live.present().is_some() {
            result_live
        } else {
            current_live
        },
    ))
}

fn imported_live_head(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    path_ref: usize,
) -> Result<HeadV1, SyncError> {
    let state = select_snapshot_by_path_in_tx(
        tx,
        &payload.workspace_id,
        &payload.target_version_id,
        &payload.paths[path_ref],
    )
    .map_err(map_local_domain_error)?;
    let updated = state
        .binary_object_id
        .as_deref()
        .map(|object_id| {
            snapshot_updated_at_ms(
                tx,
                &payload.workspace_id,
                &payload.target_version_id,
                object_id,
            )
        })
        .transpose()?;
    head_from_conflict_side(&state, path_ref, updated)
}

fn preflight_imported_lineage(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    key: Option<&DocKey>,
    disposition: ImportedHeadDisposition,
) -> Result<(), SyncError> {
    let Some(transition) = payload.lineage_transition.as_ref() else {
        return Ok(());
    };
    let key = key.ok_or(SyncError::InvalidInput {
        reason: "conflict.resolve lineage transition has no current object",
    })?;
    if disposition == ImportedHeadDisposition::AlreadyResult {
        if let Some(successor) = transition.successor.as_ref() {
            let marker = dohc_engine_collab::read_marker_in_tx(tx, key)
                .map_err(map_local_collab_error)?
                .ok_or(SyncError::RetryableState {
                    reason: "ydoc-lineage-result-missing",
                })?;
            if marker.lineage_claim_status != LineageClaimStatus::Exact
                || marker.lineage_claim_id.as_deref() != Some(successor.lineage_claim_id.as_str())
            {
                return Err(SyncError::RetryableState {
                    reason: "ydoc-lineage-result-mismatch",
                });
            }
            let doc =
                dohc_engine_collab::load_doc_in_tx(tx, key).map_err(map_local_collab_error)?;
            if doc.has_pending_dependencies()
                || dohc_engine_storage::hex_sha256(&doc.encode_state_vector())
                    != successor.state_vector_blob_sha256
            {
                return Err(SyncError::RetryableState {
                    reason: "ydoc-lineage-result-mismatch",
                });
            }
            return Ok(());
        }
        let archived: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_inactive_lineages \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                   AND lineage_claim_id=?4 AND disposition='superseded-predecessor' \
                   AND state_vector_blob_sha256=?5)",
                params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    transition.predecessor_claim_id,
                    transition.predecessor_state_vector_sha256,
                ],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        return if archived {
            Ok(())
        } else {
            Err(SyncError::RetryableState {
                reason: "ydoc-lineage-result-missing",
            })
        };
    }
    let marker = dohc_engine_collab::read_marker_in_tx(tx, key)
        .map_err(map_local_collab_error)?
        .ok_or(SyncError::RetryableState {
            reason: "ydoc-lineage-missing",
        })?;
    if marker.lineage_claim_status != LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(transition.predecessor_claim_id.as_str())
    {
        return Err(SyncError::RetryableState {
            reason: "ydoc-lineage-predecessor-mismatch",
        });
    }
    let deferred: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
    if deferred {
        return Err(SyncError::RetryableState {
            reason: "ydoc-deferred-updates-pending",
        });
    }
    let doc = dohc_engine_collab::load_doc_in_tx(tx, key).map_err(map_local_collab_error)?;
    if doc.has_pending_dependencies() {
        return Err(SyncError::RetryableState {
            reason: "ydoc-incomplete-lineage",
        });
    }
    if dohc_engine_storage::hex_sha256(&doc.encode_state_vector())
        != transition.predecessor_state_vector_sha256
    {
        return Err(SyncError::RetryableState {
            reason: "ydoc-lineage-state-vector-changed",
        });
    }
    Ok(())
}

fn imported_successor(
    tx: &Transaction<'_>,
    transition: &LineageTransitionV1,
    successor: &SuccessorV1,
) -> Result<SuccessorBase, SyncError> {
    let update: Vec<u8> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&successor.update_blob_sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let state_vector: Vec<u8> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&successor.state_vector_blob_sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(SuccessorBase {
        lineage_claim_id: successor.lineage_claim_id.clone(),
        epoch_tag: successor.epoch_tag.clone(),
        content_kind: match successor.content_kind {
            SuccessorContentKindV1::Plaintext => ContentKind::Plaintext,
            SuccessorContentKindV1::Richdoc => ContentKind::Richdoc,
        },
        predecessor_state_vector_sha256: transition.predecessor_state_vector_sha256.clone(),
        artifact_preimage_sha256: transition.artifact_preimage_sha256.clone(),
        result_sha256: successor.result_sha256.clone(),
        update,
        state_vector,
    })
}

fn commit_imported_lineage(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    key: Option<&DocKey>,
    now_ms: i64,
) -> Result<(), SyncError> {
    let Some(transition) = payload.lineage_transition.as_ref() else {
        return reconcile_unbound_receiver_lineages(tx, payload, now_ms);
    };
    let key = key.ok_or(SyncError::InvalidInput {
        reason: "conflict.resolve lineage transition has no current object",
    })?;
    if let Some(successor) = transition.successor.as_ref() {
        let successor_base = imported_successor(tx, transition, successor)?;
        let result = payload.result.present().ok_or(SyncError::InvalidInput {
            reason: "conflict.resolve successor has no result",
        })?;
        dohc_engine_collab::replace_lineage_with_successor_in_tx(
            tx,
            SuccessorReplacement {
                key,
                expected_predecessor_claim_id: &transition.predecessor_claim_id,
                expected_predecessor_state_vector_sha256: &transition
                    .predecessor_state_vector_sha256,
                path: &payload.paths[result.path_ref],
                successor: &successor_base,
                now_ms,
            },
        )
        .map_err(map_local_collab_error)?;
    } else {
        dohc_engine_collab::archive_active_lineage_in_tx(
            tx,
            key,
            &transition.predecessor_claim_id,
            &transition.predecessor_state_vector_sha256,
            payload
                .current
                .present()
                .map(|head| head.blob_sha256.as_str()),
            now_ms,
        )
        .map_err(map_local_collab_error)?;
    }
    Ok(())
}

fn reconcile_unbound_receiver_lineages(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    now_ms: i64,
) -> Result<(), SyncError> {
    let current_key = payload
        .current
        .present()
        .map(|head| {
            DocKey::new(
                &payload.workspace_id,
                &payload.target_version_id,
                &head.object_id,
            )
            .map_err(|_| SyncError::InvalidInput {
                reason: "conflict.resolve Y.Doc coordinates are invalid",
            })
        })
        .transpose()?;
    let result_key = payload
        .result
        .present()
        .map(|head| {
            DocKey::new(
                &payload.workspace_id,
                &payload.target_version_id,
                &head.object_id,
            )
            .map_err(|_| SyncError::InvalidInput {
                reason: "conflict.resolve Y.Doc coordinates are invalid",
            })
        })
        .transpose()?;

    if let Some(result_key) = result_key.as_ref() {
        if let Some(current_key) = current_key.as_ref()
            && result_key != current_key
        {
            crate::ydoc_apply::reconcile_conflict_parent_resulting_head_in_tx(
                tx,
                current_key,
                crate::ResultingHead::BinaryOrAbsent,
                now_ms,
            )?;
        }
        reconcile_unbound_result_head(tx, payload, result_key, now_ms)?;
    } else if let Some(current_key) = current_key.as_ref() {
        crate::ydoc_apply::reconcile_conflict_parent_resulting_head_in_tx(
            tx,
            current_key,
            crate::ResultingHead::BinaryOrAbsent,
            now_ms,
        )?;
    }
    Ok(())
}

fn reconcile_unbound_result_head(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    key: &DocKey,
    now_ms: i64,
) -> Result<(), SyncError> {
    let result = payload.result.present().ok_or(SyncError::InvalidInput {
        reason: "conflict.resolve result object is absent",
    })?;
    match result.content_kind {
        HeadContentKindV1::Binary => {
            crate::ydoc_apply::reconcile_conflict_parent_resulting_head_in_tx(
                tx,
                key,
                crate::ResultingHead::BinaryOrAbsent,
                now_ms,
            )
        }
        HeadContentKindV1::Text => {
            let text: String = tx
                .query_row(
                    "SELECT text FROM blobs WHERE sha256=?1",
                    [&result.blob_sha256],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            crate::ydoc_apply::reconcile_conflict_parent_resulting_head_in_tx(
                tx,
                key,
                crate::ResultingHead::Text {
                    path: &payload.paths[result.path_ref],
                    text: &text,
                },
                now_ms,
            )
        }
    }
}

fn close_imported_conflict(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
) -> Result<(), SyncError> {
    let choice = match payload.chosen_from {
        ResolveChoiceV1::Current => "current",
        ResolveChoiceV1::Incoming => "incoming",
        ResolveChoiceV1::Merged => "merged",
    };
    let resolution = match payload.resolution {
        ResolutionV1::KeptCurrent => "kept-current",
        ResolutionV1::AppliedIncoming => "applied-incoming",
        ResolutionV1::AppliedMerged => "applied-merged",
    };
    tx.execute(
        "UPDATE conflicts SET status='resolved',chosen_from=?3,resolution=?4,updated_at_ms=?5 \
         WHERE workspace_id=?1 AND conflict_id=?2 AND status='open'",
        params![
            payload.workspace_id,
            payload.conflict_id,
            choice,
            resolution,
            payload.effect_context.recorded_at_ms
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn conflict_state_from_head(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    head: &HeadV1,
) -> Result<ConflictFileState, SyncError> {
    let path = payload.paths[head.path_ref()].clone();
    let Some(head) = head.present() else {
        return Ok(ConflictFileState::text(path, None));
    };
    match head.content_kind {
        HeadContentKindV1::Text => {
            let text: String = tx
                .query_row(
                    "SELECT text FROM blobs WHERE sha256=?1",
                    [&head.blob_sha256],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            Ok(ConflictFileState::text(
                path.clone(),
                Some(TextSnapshot {
                    workspace_id: payload.workspace_id.clone(),
                    version_id: payload.target_version_id.clone(),
                    object_id: head.object_id.clone(),
                    path,
                    text,
                    blob_sha256: head.blob_sha256.clone(),
                    updated_at_ms: head.updated_at_ms,
                    latest_moment_id: head.latest_moment_id.clone(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                }),
            ))
        }
        HeadContentKindV1::Binary => Ok(ConflictFileState::binary_head(
            path,
            &head.blob_sha256,
            head.byte_length,
            &head.object_id,
            &head.latest_moment_id,
            head.updated_at_ms,
        )),
    }
}

fn open_divergent_result_review(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    live: &HeadV1,
) -> Result<(String, bool), SyncError> {
    let seed = format!(
        "{}\0{}\0{}\0{}",
        payload.workspace_id,
        payload.conflict_id,
        live.present()
            .map(|head| head.latest_moment_id.as_str())
            .unwrap_or("absent"),
        payload
            .result
            .present()
            .map(|head| head.latest_moment_id.as_str())
            .unwrap_or("absent"),
    );
    let review_id = format!(
        "conflict_sync_{}",
        &dohc_engine_storage::hex_sha256(seed.as_bytes())[..32]
    );
    let conflict = TextConflict {
        conflict_id: review_id.clone(),
        workspace_id: payload.workspace_id.clone(),
        path: payload.paths[live.path_ref()].clone(),
        target_version_id: payload.target_version_id.clone(),
        source_version_id: payload.source_version_id.clone(),
        created_at_ms: payload.effect_context.recorded_at_ms,
        updated_at_ms: payload.effect_context.recorded_at_ms,
        status: dohc_engine_domain::ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: dohc_engine_domain::ConflictMetadata::origin("sync"),
        base: conflict_state_from_head(tx, payload, &payload.current)?,
        current: conflict_state_from_head(tx, payload, live)?,
        incoming: conflict_state_from_head(tx, payload, &payload.result)?,
    };
    let inserted = insert_text_conflict_if_absent(tx, &conflict).map_err(map_local_domain_error)?;
    Ok((review_id, inserted))
}

fn archive_conflicting_successor(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
    review_conflict_id: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let Some(transition) = payload.lineage_transition.as_ref() else {
        return Ok(());
    };
    let Some(successor) = transition.successor.as_ref() else {
        return Ok(());
    };
    let Some(current) = payload.current.present() else {
        return Ok(());
    };
    let base = imported_successor(tx, transition, successor)?;
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&base.update).map_err(map_local_collab_error)?;
    if doc.has_pending_dependencies()
        || dohc_engine_storage::hex_sha256(&doc.encode_state_vector())
            != successor.state_vector_blob_sha256
    {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve successor bytes are invalid",
        });
    }
    tx.execute(
        "INSERT OR IGNORE INTO ydoc_inactive_lineages (workspace_id,version_id,object_id, \
         lineage_claim_id,parent_claim_id,disposition,content_kind,path,epoch_tag, \
         full_state_blob_sha256,state_vector_blob_sha256,open_conflict_id,recorded_at_ms,updated_at_ms) \
         VALUES (?1,?2,?3,?4,?5,'conflicting-successor',?6,?7,?8,?9,?10,?11,?12,?12)",
        params![
            payload.workspace_id,
            payload.target_version_id,
            current.object_id,
            successor.lineage_claim_id,
            transition.predecessor_claim_id,
            match successor.content_kind { SuccessorContentKindV1::Plaintext => "plaintext", SuccessorContentKindV1::Richdoc => "richdoc" },
            payload.paths[payload.result.path_ref()],
            successor.epoch_tag,
            successor.update_blob_sha256,
            successor.state_vector_blob_sha256,
            review_conflict_id,
            now_ms,
        ],
    ).map_err(SyncError::persist)?;
    Ok(())
}

/// Preflight one local resolution before its domain effects run.
///
/// The returned plan binds the exact artifact head, lineage state vector,
/// canonical successor bytes, effect shadows, and payload limits. The caller
/// must commit it in the same transaction after the domain mutation.
pub fn prepare_local_conflict_resolve_v1_in_tx(
    tx: &Transaction<'_>,
    input: &ResolveTextConflict,
    conflict: &TextConflict,
) -> Result<PreparedLocalConflictResolveV1, SyncError> {
    let (current_binary_updated_at_ms, incoming_binary_updated_at_ms) = tx
        .query_row(
            "SELECT current_updated_at_ms,incoming_updated_at_ms FROM conflicts \
             WHERE workspace_id=?1 AND conflict_id=?2",
            params![input.workspace_id, input.conflict_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(SyncError::corrupt)?;

    let mut paths = vec![conflict.current.path.clone()];
    let incoming_path_ref = intern_path(&mut paths, &conflict.incoming.path);
    let current = head_from_conflict_side(&conflict.current, 0, current_binary_updated_at_ms)?;
    let incoming = head_from_conflict_side(
        &conflict.incoming,
        incoming_path_ref,
        incoming_binary_updated_at_ms,
    )?;
    let (result_path, result, result_text) = planned_result(input, conflict, &current)?;
    let result_path_ref = intern_path(&mut paths, &result_path);
    let result = with_path_ref(result, result_path_ref);
    let effects = planned_effects(input, &current, &result);

    let current_object_created_at_ms = current
        .present()
        .map(|head| object_created_at_ms(tx, &input.workspace_id, &head.object_id))
        .transpose()?;
    let result_object_created_at_ms = result
        .present()
        .map(|head| {
            if current
                .present()
                .is_some_and(|current| current.object_id == head.object_id)
            {
                current_object_created_at_ms.ok_or_else(|| {
                    SyncError::Storage(StorageError::corrupt_public(std::io::Error::other(
                        "conflict.resolve current object has no creation time",
                    )))
                })
            } else {
                optional_object_created_at_ms(tx, &input.workspace_id, &head.object_id)
                    .map(|created| created.unwrap_or(input.now_ms))
            }
        })
        .transpose()?;

    let pre_effect_moment_order = tx
        .query_row(
            "SELECT COALESCE(MAX(moment_order),0) FROM moments WHERE workspace_id=?1",
            [&input.workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(SyncError::corrupt)?;
    let mut payload = ConflictResolveV1 {
        workspace_id: input.workspace_id.clone(),
        conflict_id: input.conflict_id.clone(),
        chosen_from: planned_choice(&input.resolution),
        resolution: planned_resolution(&input.resolution),
        target_version_id: conflict.target_version_id.clone(),
        source_version_id: conflict.source_version_id.clone(),
        paths,
        current,
        incoming,
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: input.now_ms,
            metadata: MetadataV1 {
                origin: local_replicated_moment_origin(&input.metadata_origin)?.to_owned(),
                summary: input.metadata_summary.clone(),
                correlation_id: input.metadata_correlation_id.clone(),
            },
            author: local_author(input.author_json.as_deref())?,
            current_object_created_at_ms,
            result_object_created_at_ms,
        },
        effects,
        lineage_transition: None,
    };
    let lineage = prepare_local_lineage_in_tx(tx, conflict, &payload, result_text.as_deref())?;
    payload.lineage_transition = lineage_transition(&lineage);
    let built = build_conflict_resolve_v1(payload)?;
    Ok(PreparedLocalConflictResolveV1 {
        built,
        pre_effect_moment_order,
        lineage,
    })
}

/// Commit a preflighted local resolution after its domain effects.
///
/// This verifies the resulting head, performs the admitted lineage transition,
/// and persists the resolve-first bundle. Any failure rolls back the domain
/// mutation because the caller still owns the outer transaction.
pub fn commit_local_conflict_resolve_v1_in_tx(
    tx: &Transaction<'_>,
    prepared: &PreparedLocalConflictResolveV1,
    result: &ResolveTextConflictResult,
) -> Result<(), SyncError> {
    verify_local_result_in_tx(tx, &prepared.built.validated.payload, result)?;
    match &prepared.lineage {
        LocalLineagePlan::None => {}
        LocalLineagePlan::ExactSuccessor {
            key,
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            path,
            successor,
        } => {
            dohc_engine_collab::replace_lineage_with_successor_in_tx(
                tx,
                SuccessorReplacement {
                    key,
                    expected_predecessor_claim_id: predecessor_claim_id,
                    expected_predecessor_state_vector_sha256: predecessor_state_vector_sha256,
                    path,
                    successor,
                    now_ms: result.conflict.updated_at_ms,
                },
            )
            .map_err(map_local_collab_error)?;
        }
        LocalLineagePlan::ExactArchive {
            key,
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            last_surfaced_projection_sha256,
            ..
        } => {
            dohc_engine_collab::archive_active_lineage_in_tx(
                tx,
                key,
                predecessor_claim_id,
                predecessor_state_vector_sha256,
                last_surfaced_projection_sha256.as_deref(),
                result.conflict.updated_at_ms,
            )
            .map_err(map_local_collab_error)?;
        }
        LocalLineagePlan::UnclaimedText { key, path, text } => {
            crate::fold_resolution_into_ydoc_in_tx(
                tx,
                &key.workspace_id,
                &key.version_id,
                &key.object_id,
                path,
                text,
                result.conflict.updated_at_ms,
            )?;
        }
        LocalLineagePlan::UnclaimedBareRetire { key } => {
            crate::retire_ydoc_lineage_in_tx(
                tx,
                &key.workspace_id,
                &key.version_id,
                &key.object_id,
            )?;
        }
    }
    crate::conflict_outbox::persist_local_conflict_resolve_v1_in_tx(
        tx,
        &prepared.built,
        prepared.pre_effect_moment_order,
    )
}

fn planned_choice(resolution: &ResolveConflictKind) -> ResolveChoiceV1 {
    match resolution {
        ResolveConflictKind::KeepCurrent => ResolveChoiceV1::Current,
        ResolveConflictKind::ApplyIncoming => ResolveChoiceV1::Incoming,
        ResolveConflictKind::ApplyMerged { .. } => ResolveChoiceV1::Merged,
    }
}

fn planned_resolution(resolution: &ResolveConflictKind) -> ResolutionV1 {
    match resolution {
        ResolveConflictKind::KeepCurrent => ResolutionV1::KeptCurrent,
        ResolveConflictKind::ApplyIncoming => ResolutionV1::AppliedIncoming,
        ResolveConflictKind::ApplyMerged { .. } => ResolutionV1::AppliedMerged,
    }
}

fn intern_path(paths: &mut Vec<String>, path: &str) -> usize {
    if let Some(index) = paths.iter().position(|candidate| candidate == path) {
        index
    } else {
        paths.push(path.to_owned());
        paths.len() - 1
    }
}

fn with_path_ref(head: HeadV1, path_ref: usize) -> HeadV1 {
    match head {
        HeadV1::Absent { .. } => HeadV1::Absent { path_ref },
        HeadV1::Present(mut head) => {
            head.path_ref = path_ref;
            HeadV1::Present(head)
        }
    }
}

fn head_from_conflict_side(
    side: &ConflictFileState,
    path_ref: usize,
    binary_updated_at_ms: Option<i64>,
) -> Result<HeadV1, SyncError> {
    if let Some(snapshot) = side.snapshot.as_ref() {
        if side.content_kind != ConflictContentKind::Text || side.binary_sha256.is_some() {
            return Err(corrupt_local(
                "text conflict side has inconsistent content fields",
            ));
        }
        return Ok(HeadV1::Present(PresentHeadV1 {
            path_ref,
            object_id: snapshot.object_id.clone(),
            latest_moment_id: snapshot.latest_moment_id.clone(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: snapshot.blob_sha256.clone(),
            byte_length: i64::try_from(snapshot.text.len()).map_err(|_| {
                SyncError::InputTooLarge {
                    constraint: "MAX_WIRE_INTEGER",
                    limit_bytes: usize::try_from(MAX_WIRE_INTEGER).unwrap_or(usize::MAX),
                    observed_bytes: snapshot.text.len(),
                }
            })?,
            updated_at_ms: snapshot.updated_at_ms,
        }));
    }
    if let Some(binary_sha256) = side.binary_sha256.as_ref() {
        if side.content_kind != ConflictContentKind::Binary {
            return Err(corrupt_local(
                "binary conflict side has inconsistent content kind",
            ));
        }
        return Ok(HeadV1::Present(PresentHeadV1 {
            path_ref,
            object_id: side.binary_object_id.clone().ok_or_else(|| {
                corrupt_local("binary conflict side is missing its object identity")
            })?,
            latest_moment_id: side.binary_latest_moment_id.clone().ok_or_else(|| {
                corrupt_local("binary conflict side is missing its latest moment")
            })?,
            content_kind: HeadContentKindV1::Binary,
            blob_sha256: binary_sha256.clone(),
            byte_length: side
                .binary_byte_length
                .ok_or_else(|| corrupt_local("binary conflict side is missing its byte length"))?,
            updated_at_ms: binary_updated_at_ms
                .ok_or_else(|| corrupt_local("binary conflict side is missing its update time"))?,
        }));
    }
    Ok(HeadV1::Absent { path_ref })
}

fn planned_result(
    input: &ResolveTextConflict,
    conflict: &TextConflict,
    current: &HeadV1,
) -> Result<(String, HeadV1, Option<String>), SyncError> {
    match &input.resolution {
        ResolveConflictKind::KeepCurrent => Ok((
            conflict.current.path.clone(),
            current.clone(),
            conflict
                .current
                .snapshot
                .as_ref()
                .map(|head| head.text.clone()),
        )),
        ResolveConflictKind::ApplyIncoming => {
            let side = &conflict.incoming;
            let object_id = if side.path == conflict.current.path {
                current
                    .present()
                    .map_or_else(|| input.object_id.clone(), |head| head.object_id.clone())
            } else {
                input.object_id.clone()
            };
            if let Some(snapshot) = side.snapshot.as_ref() {
                let text = snapshot.text.clone();
                Ok((
                    side.path.clone(),
                    HeadV1::Present(PresentHeadV1 {
                        path_ref: 0,
                        object_id,
                        latest_moment_id: input.write_moment_id.clone(),
                        content_kind: HeadContentKindV1::Text,
                        blob_sha256: snapshot.blob_sha256.clone(),
                        byte_length: i64::try_from(text.len()).map_err(|_| {
                            SyncError::InputTooLarge {
                                constraint: "MAX_WIRE_INTEGER",
                                limit_bytes: usize::try_from(MAX_WIRE_INTEGER)
                                    .unwrap_or(usize::MAX),
                                observed_bytes: text.len(),
                            }
                        })?,
                        updated_at_ms: input.now_ms,
                    }),
                    Some(text),
                ))
            } else if let Some(binary_sha256) = side.binary_sha256.as_ref() {
                Ok((
                    side.path.clone(),
                    HeadV1::Present(PresentHeadV1 {
                        path_ref: 0,
                        object_id,
                        latest_moment_id: input.write_moment_id.clone(),
                        content_kind: HeadContentKindV1::Binary,
                        blob_sha256: binary_sha256.clone(),
                        byte_length: side.binary_byte_length.ok_or_else(|| {
                            corrupt_local("binary conflict result is missing its byte length")
                        })?,
                        updated_at_ms: input.now_ms,
                    }),
                    None,
                ))
            } else {
                Ok((side.path.clone(), HeadV1::Absent { path_ref: 0 }, None))
            }
        }
        ResolveConflictKind::ApplyMerged { text } => {
            let object_id = current
                .present()
                .map_or_else(|| input.object_id.clone(), |head| head.object_id.clone());
            Ok((
                conflict.current.path.clone(),
                HeadV1::Present(PresentHeadV1 {
                    path_ref: 0,
                    object_id,
                    latest_moment_id: input.write_moment_id.clone(),
                    content_kind: HeadContentKindV1::Text,
                    blob_sha256: dohc_engine_storage::hex_sha256(text.as_bytes()),
                    byte_length: i64::try_from(text.len()).map_err(|_| {
                        SyncError::InputTooLarge {
                            constraint: "MAX_WIRE_INTEGER",
                            limit_bytes: usize::try_from(MAX_WIRE_INTEGER).unwrap_or(usize::MAX),
                            observed_bytes: text.len(),
                        }
                    })?,
                    updated_at_ms: input.now_ms,
                }),
                Some(text.clone()),
            ))
        }
    }
}

fn planned_effects(
    input: &ResolveTextConflict,
    current: &HeadV1,
    result: &HeadV1,
) -> Vec<EffectV1> {
    expected_effect_kinds(current, result)
        .iter()
        .map(|kind| EffectV1 {
            kind: *kind,
            moment_id: match kind {
                EffectKindV1::Delete => input.delete_moment_id.clone(),
                EffectKindV1::Write => input.write_moment_id.clone(),
            },
            payload_sha256: "0".repeat(64),
        })
        .collect()
}

fn expected_effect_kinds(current: &HeadV1, result: &HeadV1) -> &'static [EffectKindV1] {
    if current == result {
        &[]
    } else if current.present().is_some() && result.present().is_none() {
        &[EffectKindV1::Delete]
    } else if current.present().is_some()
        && result.present().is_some()
        && current.path_ref() != result.path_ref()
    {
        &[EffectKindV1::Delete, EffectKindV1::Write]
    } else if result.present().is_some() {
        &[EffectKindV1::Write]
    } else {
        &[]
    }
}

fn prepare_local_lineage_in_tx(
    tx: &Transaction<'_>,
    conflict: &TextConflict,
    payload: &ConflictResolveV1,
    result_text: Option<&str>,
) -> Result<LocalLineagePlan, SyncError> {
    let Some(current) = payload.current.present() else {
        return Ok(LocalLineagePlan::None);
    };
    let key = DocKey::new(
        &payload.workspace_id,
        &payload.target_version_id,
        &current.object_id,
    )
    .map_err(|_| SyncError::InvalidInput {
        reason: "conflict.resolve Y.Doc coordinates are invalid",
    })?;
    let Some(marker) =
        dohc_engine_collab::read_marker_in_tx(tx, &key).map_err(map_local_collab_error)?
    else {
        return Ok(LocalLineagePlan::None);
    };
    let deferred: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if deferred {
        return Err(SyncError::RetryableState {
            reason: "ydoc-deferred-updates-pending",
        });
    }
    let doc = dohc_engine_collab::load_doc_in_tx(tx, &key).map_err(map_local_collab_error)?;
    if doc.has_pending_dependencies() {
        return Err(SyncError::RetryableState {
            reason: "ydoc-incomplete-lineage",
        });
    }
    if marker
        .path
        .as_deref()
        .is_some_and(|path| path != conflict.current.path)
    {
        return Err(SyncError::RetryableState {
            reason: "ydoc-lineage-path-changed",
        });
    }

    let result_is_same_text_object = payload.result.present().is_some_and(|result| {
        result.content_kind == HeadContentKindV1::Text && result.object_id == current.object_id
    });
    match marker.lineage_claim_status {
        LineageClaimStatus::Missing | LineageClaimStatus::Ambiguous => {
            Err(SyncError::RetryableState {
                reason: "ydoc-lineage-claim-unresolved",
            })
        }
        LineageClaimStatus::Unclaimed if result_is_same_text_object => {
            Ok(LocalLineagePlan::UnclaimedText {
                key,
                path: payload.paths[payload.result.path_ref()].clone(),
                text: result_text
                    .ok_or_else(|| corrupt_local("text conflict result has no canonical body"))?
                    .to_owned(),
            })
        }
        LineageClaimStatus::Unclaimed => {
            if marker.head_update_seq > 0 || marker.head_snapshot_seq > 0 {
                return Err(SyncError::RetryableState {
                    reason: "ydoc-unsettled-local-lineage",
                });
            }
            Ok(LocalLineagePlan::UnclaimedBareRetire { key })
        }
        LineageClaimStatus::Exact => {
            let predecessor_claim_id = marker
                .lineage_claim_id
                .clone()
                .ok_or_else(|| corrupt_local("exact Y.Doc lineage is missing its claim ID"))?;
            let predecessor_state_vector = doc.encode_state_vector();
            let predecessor_state_vector_sha256 =
                dohc_engine_storage::hex_sha256(&predecessor_state_vector);
            if result_is_same_text_object {
                if current.content_kind != HeadContentKindV1::Text {
                    return Err(corrupt_local(
                        "text successor is attached to a non-text artifact head",
                    ));
                }
                let result = payload
                    .result
                    .present()
                    .ok_or_else(|| corrupt_local("text successor has no result head"))?;
                let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
                    key: &key,
                    predecessor_claim_id: &predecessor_claim_id,
                    predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
                    artifact_op_kind: "conflict.resolve",
                    artifact_id: &payload.conflict_id,
                    artifact_preimage_sha256: &current.blob_sha256,
                    content_kind: marker.content_kind,
                    result_sha256: &result.blob_sha256,
                });
                let successor = fresh_successor_base(
                    &identity,
                    result_text
                        .ok_or_else(|| corrupt_local("text successor has no canonical body"))?,
                )
                .map_err(map_local_collab_error)?;
                Ok(LocalLineagePlan::ExactSuccessor {
                    key,
                    predecessor_claim_id,
                    predecessor_state_vector_sha256,
                    path: payload.paths[result.path_ref].clone(),
                    successor,
                })
            } else {
                Ok(LocalLineagePlan::ExactArchive {
                    key,
                    predecessor_claim_id,
                    predecessor_state_vector_sha256,
                    artifact_preimage_sha256: current.blob_sha256.clone(),
                    last_surfaced_projection_sha256: (current.content_kind
                        == HeadContentKindV1::Text)
                        .then(|| current.blob_sha256.clone()),
                })
            }
        }
    }
}

fn lineage_transition(plan: &LocalLineagePlan) -> Option<LineageTransitionV1> {
    match plan {
        LocalLineagePlan::ExactSuccessor {
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            successor,
            ..
        } => Some(LineageTransitionV1 {
            predecessor_claim_id: predecessor_claim_id.clone(),
            predecessor_state_vector_sha256: predecessor_state_vector_sha256.clone(),
            artifact_preimage_sha256: successor.artifact_preimage_sha256.clone(),
            successor: Some(SuccessorV1 {
                lineage_claim_id: successor.lineage_claim_id.clone(),
                epoch_tag: successor.epoch_tag.clone(),
                content_kind: match successor.content_kind {
                    ContentKind::Plaintext => SuccessorContentKindV1::Plaintext,
                    ContentKind::Richdoc => SuccessorContentKindV1::Richdoc,
                },
                result_sha256: successor.result_sha256.clone(),
                update_blob_sha256: successor.lineage_claim_id.clone(),
                state_vector_blob_sha256: dohc_engine_storage::hex_sha256(&successor.state_vector),
            }),
        }),
        LocalLineagePlan::ExactArchive {
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            artifact_preimage_sha256,
            ..
        } => Some(LineageTransitionV1 {
            predecessor_claim_id: predecessor_claim_id.clone(),
            predecessor_state_vector_sha256: predecessor_state_vector_sha256.clone(),
            artifact_preimage_sha256: artifact_preimage_sha256.clone(),
            successor: None,
        }),
        _ => None,
    }
}

fn verify_local_result_in_tx(
    tx: &Transaction<'_>,
    expected: &ConflictResolveV1,
    result: &ResolveTextConflictResult,
) -> Result<(), SyncError> {
    let expected_choice = match expected.chosen_from {
        ResolveChoiceV1::Current => ConflictChoice::Current,
        ResolveChoiceV1::Incoming => ConflictChoice::Incoming,
        ResolveChoiceV1::Merged => ConflictChoice::Merged,
    };
    let expected_resolution = match expected.resolution {
        ResolutionV1::KeptCurrent => ConflictResolution::KeptCurrent,
        ResolutionV1::AppliedIncoming => ConflictResolution::AppliedIncoming,
        ResolutionV1::AppliedMerged => ConflictResolution::AppliedMerged,
    };
    if result.conflict.chosen_from != expected_choice
        || result.conflict.resolution != Some(expected_resolution)
        || result.conflict.status != ConflictStatus::Resolved
        || result.conflict.workspace_id != expected.workspace_id
        || result.conflict.conflict_id != expected.conflict_id
        || result.conflict.target_version_id != expected.target_version_id
        || result.conflict.source_version_id != expected.source_version_id
        || result.conflict.updated_at_ms != expected.effect_context.recorded_at_ms
    {
        return Err(corrupt_local(
            "conflict.resolve domain outcome does not match its preflight",
        ));
    }
    let actual_effects = result
        .delete
        .iter()
        .map(|delete| (EffectKindV1::Delete, delete.moment.moment_id.as_str()))
        .chain(
            result
                .write
                .iter()
                .map(|write| (EffectKindV1::Write, write.moment.moment_id.as_str())),
        )
        .chain(
            result
                .binary_write
                .iter()
                .map(|write| (EffectKindV1::Write, write.moment_id.as_str())),
        )
        .collect::<Vec<_>>();
    if actual_effects.len() != expected.effects.len()
        || actual_effects
            .iter()
            .zip(&expected.effects)
            .any(|((kind, moment_id), effect)| {
                *kind != effect.kind || *moment_id != effect.moment_id
            })
    {
        return Err(corrupt_local(
            "conflict.resolve domain effects do not match their preflight",
        ));
    }
    for (effect_index, effect) in expected.effects.iter().enumerate() {
        let actual = durable_effect_shadow_in_tx(
            tx,
            &expected.workspace_id,
            &effect.moment_id,
            &expected.conflict_id,
            effect_index,
        )?;
        let shadow = match effect.kind {
            EffectKindV1::Delete => delete_shadow(expected, effect, effect_index)?,
            EffectKindV1::Write => write_shadow(expected, effect, effect_index)?,
        };
        if actual != shadow {
            return Err(corrupt_local(
                "conflict.resolve durable effect does not match its preflight",
            ));
        }
    }

    let result_path = &expected.paths[expected.result.path_ref()];
    let live = select_snapshot_by_path_in_tx(
        tx,
        &expected.workspace_id,
        &expected.target_version_id,
        result_path,
    )
    .map_err(map_local_domain_error)?;
    let binary_updated_at_ms = live
        .binary_object_id
        .as_ref()
        .map(|object_id| {
            snapshot_updated_at_ms(
                tx,
                &expected.workspace_id,
                &expected.target_version_id,
                object_id,
            )
        })
        .transpose()?;
    let actual = head_from_conflict_side(&live, expected.result.path_ref(), binary_updated_at_ms)?;
    if actual != expected.result {
        return Err(corrupt_local(
            "conflict.resolve resulting head does not match its preflight",
        ));
    }
    if expected.current.path_ref() != expected.result.path_ref()
        && expected.current.present().is_some()
    {
        let old_path = &expected.paths[expected.current.path_ref()];
        if select_snapshot_by_path_in_tx(
            tx,
            &expected.workspace_id,
            &expected.target_version_id,
            old_path,
        )
        .map_err(map_local_domain_error)?
        .is_present()
        {
            return Err(corrupt_local(
                "conflict.resolve path change left the old head present",
            ));
        }
    }
    Ok(())
}

pub(crate) fn durable_effect_shadow_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    conflict_id: &str,
    effect_index: usize,
) -> Result<Value, SyncError> {
    let (mut shadow, _) =
        crate::outbound::moment_append_payload_in_tx(tx, workspace_id, moment_id)?;
    shadow["beforeMetadata"] = Value::Null;
    let record = shadow
        .as_object_mut()
        .ok_or_else(|| corrupt_local("conflict.resolve durable effect is not a JSON object"))?;
    record.insert("conflictId".to_owned(), json!(conflict_id));
    record.insert("conflictEffectIndex".to_owned(), json!(effect_index));
    Ok(shadow)
}

fn object_created_at_ms(
    tx: &Transaction<'_>,
    workspace_id: &str,
    object_id: &str,
) -> Result<i64, SyncError> {
    optional_object_created_at_ms(tx, workspace_id, object_id)?
        .ok_or_else(|| corrupt_local("conflict.resolve head points at a missing file object"))
}

fn optional_object_created_at_ms(
    tx: &Transaction<'_>,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<i64>, SyncError> {
    tx.query_row(
        "SELECT created_at_ms FROM file_objects WHERE workspace_id=?1 AND object_id=?2",
        params![workspace_id, object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn snapshot_updated_at_ms(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<i64, SyncError> {
    tx.query_row(
        "SELECT updated_at_ms FROM snapshots \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![workspace_id, version_id, object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

fn local_author(author_json: Option<&str>) -> Result<Option<AgentAuthorV1>, SyncError> {
    let Some(author_json) = author_json else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(author_json).map_err(|_| SyncError::InvalidInput {
        reason: "conflict.resolve author is not valid JSON",
    })?;
    let record = value.as_object().ok_or(SyncError::InvalidInput {
        reason: "conflict.resolve author must be an object",
    })?;
    if record.keys().any(|field| {
        !matches!(
            field.as_str(),
            "kind" | "agentId" | "onBehalfOf" | "agentRunId"
        )
    }) {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve author has unknown fields",
        });
    }
    if record.get("kind").and_then(Value::as_str) != Some("agent") {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve author kind must be agent",
        });
    }
    let required = |field: &'static str| -> Result<String, SyncError> {
        record
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(SyncError::InvalidInput {
                reason: "conflict.resolve author field must be a non-empty string",
            })
    };
    let agent_run_id = match record.get("agentRunId") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or(SyncError::InvalidInput {
                    reason: "conflict.resolve agentRunId must be null or a non-empty string",
                })?,
        ),
    };
    Ok(Some(AgentAuthorV1 {
        agent_id: required("agentId")?,
        on_behalf_of: required("onBehalfOf")?,
        agent_run_id,
    }))
}

fn local_replicated_moment_origin(origin: &str) -> Result<&str, SyncError> {
    match origin {
        "api" | "local-file" | "restore" | "sync" | "unknown" => Ok(origin),
        "capture" | "ydoc" => Ok("local-file"),
        _ => Err(SyncError::InvalidInput {
            reason: "conflict.resolve metadata origin is invalid",
        }),
    }
}

fn map_local_domain_error(error: dohc_engine_domain::DomainError) -> SyncError {
    match error {
        dohc_engine_domain::DomainError::Storage(storage) => SyncError::Storage(storage),
        other => SyncError::Storage(StorageError::corrupt_public(other)),
    }
}

fn map_local_collab_error(error: dohc_engine_collab::CollabError) -> SyncError {
    use dohc_engine_collab::CollabError;
    match error {
        CollabError::Storage(storage) => SyncError::Storage(storage),
        CollabError::LineageIncomplete { reason } => SyncError::RetryableState {
            reason: if reason.contains("deferred") {
                "ydoc-deferred-updates-pending"
            } else {
                "ydoc-incomplete-lineage"
            },
        },
        CollabError::LineageClaimUnresolved { .. } => SyncError::RetryableState {
            reason: "ydoc-lineage-claim-unresolved",
        },
        CollabError::LineagePredecessorMismatch { .. }
        | CollabError::LineageStateVectorMismatch { .. }
        | CollabError::NoMarker => SyncError::RetryableState {
            reason: "ydoc-lineage-changed",
        },
        CollabError::ProjectionTooLarge { actual, max } => SyncError::BlobTooLarge {
            constraint: "MAX_YDOC_PROJECTION_BYTES (conflict successor)",
            limit_bytes: max,
            observed_bytes: actual,
        },
        CollabError::UpdateTooLarge { actual, max } => SyncError::BlobTooLarge {
            constraint: "MAX_YDOC_UPDATE_BYTES (conflict successor)",
            limit_bytes: max,
            observed_bytes: actual,
        },
        CollabError::SuccessorProjectionMismatch { .. }
        | CollabError::SuccessorResultMismatch { .. }
        | CollabError::ProjectionTooComplex { .. } => SyncError::InvalidInput {
            reason: "ydoc-resolution-not-representable",
        },
        other => SyncError::Storage(StorageError::corrupt_public(other)),
    }
}

fn corrupt_local(reason: &'static str) -> SyncError {
    SyncError::Storage(StorageError::corrupt_public(std::io::Error::other(reason)))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use dohc_engine_domain::{
        BinaryResolveWrite, ConflictFileState, ConflictMetadata, ConflictStatus, FileObjectRecord,
        ListMomentsQuery, ResolveTextConflictResult, VersionedTextStore, WriteResult, WriteText,
    };
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_engine_testkit::ScratchDir;

    fn compact_path_change() -> Value {
        let current_sha = dohc_engine_storage::hex_sha256(b"current text");
        let result_sha = dohc_engine_storage::hex_sha256(b"resolved text");
        let successor_sha = dohc_engine_storage::hex_sha256(b"successor ydoc state");
        let state_vector_sha = dohc_engine_storage::hex_sha256(b"successor state vector");
        let artifact_preimage_sha = current_sha.clone();
        let current = json!({
            "present": true,
            "pathRef": 0,
            "objectId": "object-a",
            "latestMomentId": "moment-current",
            "contentKind": "text",
            "blobSha256": current_sha,
            "byteLength": 12,
            "updatedAtMs": 10,
        });
        let incoming = json!({
            "present": true,
            "pathRef": 1,
            "objectId": "object-peer",
            "latestMomentId": "moment-incoming",
            "contentKind": "text",
            "blobSha256": result_sha,
            "byteLength": 13,
            "updatedAtMs": 11,
        });
        let result = json!({
            "present": true,
            "pathRef": 1,
            "objectId": "object-a",
            "latestMomentId": "moment-write",
            "contentKind": "text",
            "blobSha256": result_sha,
            "byteLength": 13,
            "updatedAtMs": 21,
        });
        json!({
            "formatVersion": 1,
            "workspaceId": "workspace-a",
            "conflictId": "conflict-1",
            "status": "resolved",
            "chosenFrom": "incoming",
            "resolution": "applied-incoming",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "paths": ["docs/a.md", "docs/b.md"],
            "transition": {
                "current": current,
                "incoming": incoming,
                "result": result,
            },
            "effectContext": {
                "recordedAtMs": 21,
                "metadata": {
                    "origin": "sync",
                    "summary": null,
                    "correlationId": "resolve-request-1",
                },
                "author": {
                    "kind": "agent",
                    "agentId": "agent-1",
                    "onBehalfOf": "user-1",
                    "agentRunId": null,
                },
                "currentObjectCreatedAtMs": 1,
                "resultObjectCreatedAtMs": 1,
            },
            "effects": [
                {
                    "kind": "delete",
                    "momentId": "moment-delete",
                    "payloadSha256": "8b196309f6d6a69295119febd37fa5d090b09df28d4faff97a238735729ddcd8",
                },
                {
                    "kind": "write",
                    "momentId": "moment-write",
                    "payloadSha256": "a605f5800e5591dd9700a75790bebf15de053df6158ec2433258e479ac034ab0",
                },
            ],
            "lineageTransition": {
                "predecessorClaimId": "a".repeat(64),
                "predecessorStateVectorSha256": "b".repeat(64),
                "artifactPreimageSha256": artifact_preimage_sha,
                "successor": {
                    "lineageClaimId": successor_sha,
                    "epochTag": "e".repeat(64),
                    "contentKind": "plaintext",
                    "resultSha256": result_sha,
                    "updateBlobSha256": successor_sha,
                    "stateVectorBlobSha256": state_vector_sha,
                },
            },
        })
    }

    fn receiver_fixture() -> (ScratchDir, EngineStore, DocKey, BuiltConflictResolveV1) {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .expect("workspace");
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-a".to_owned(),
                    path: "doc.md".to_owned(),
                    text: "current text".to_owned(),
                    moment_id: "moment-current".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("current head");
        let key = DocKey::new("ws", "main", "object-a").expect("key");
        let predecessor = dohc_engine_collab::Ydoc::wire();
        predecessor.plaintext_insert(0, "current text");
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Plaintext,
            &predecessor.encode_full_state(),
            &NoFaults,
            11,
        )
        .expect("claim predecessor");
        let marker = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker")
            .expect("claimed marker");
        let predecessor_claim_id = marker.lineage_claim_id.expect("claim id");
        let predecessor_state_vector_sha256 =
            dohc_engine_storage::hex_sha256(&predecessor.encode_state_vector());
        let current_sha = dohc_engine_storage::hex_sha256(b"current text");
        let result_sha = dohc_engine_storage::hex_sha256(b"resolved text");
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict-1",
            artifact_preimage_sha256: &current_sha,
            content_kind: ContentKind::Plaintext,
            result_sha256: &result_sha,
        });
        let successor = fresh_successor_base(&identity, "resolved text").expect("successor");
        let update_blob_sha256 = store
            .put_binary_blob(&successor.update)
            .expect("successor update");
        let state_vector_blob_sha256 = store
            .put_binary_blob(&successor.state_vector)
            .expect("successor vector");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![result_sha, "resolved text".len() as i64, "resolved text"],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("result blob");
        let current = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-a".to_owned(),
            latest_moment_id: "moment-current".to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: current_sha.clone(),
            byte_length: 12,
            updated_at_ms: 10,
        });
        let result = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-a".to_owned(),
            latest_moment_id: "moment-result".to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: result_sha.clone(),
            byte_length: 13,
            updated_at_ms: 21,
        });
        let built = build_conflict_resolve_v1(ConflictResolveV1 {
            workspace_id: "ws".to_owned(),
            conflict_id: "conflict-1".to_owned(),
            chosen_from: ResolveChoiceV1::Incoming,
            resolution: ResolutionV1::AppliedIncoming,
            target_version_id: "main".to_owned(),
            source_version_id: "peer".to_owned(),
            paths: vec!["doc.md".to_owned()],
            current,
            incoming: result.clone(),
            result,
            effect_context: EffectContextV1 {
                recorded_at_ms: 21,
                metadata: MetadataV1 {
                    origin: "sync".to_owned(),
                    summary: None,
                    correlation_id: None,
                },
                author: None,
                current_object_created_at_ms: Some(10),
                result_object_created_at_ms: Some(10),
            },
            effects: vec![EffectV1 {
                kind: EffectKindV1::Write,
                moment_id: "moment-result".to_owned(),
                payload_sha256: String::new(),
            }],
            lineage_transition: Some(LineageTransitionV1 {
                predecessor_claim_id,
                predecessor_state_vector_sha256,
                artifact_preimage_sha256: current_sha,
                successor: Some(SuccessorV1 {
                    lineage_claim_id: successor.lineage_claim_id.clone(),
                    epoch_tag: successor.epoch_tag.clone(),
                    content_kind: SuccessorContentKindV1::Plaintext,
                    result_sha256: result_sha,
                    update_blob_sha256,
                    state_vector_blob_sha256,
                }),
            }),
        })
        .expect("carrier");
        (scratch, store, key, built)
    }

    fn path_change_receiver_fixture() -> (ScratchDir, EngineStore, DocKey, BuiltConflictResolveV1) {
        let (scratch, store, key, built) = receiver_fixture();
        let mut payload = built.validated.payload;
        payload.paths.push("moved.md".to_owned());
        let mut result = payload.result.clone();
        match &mut result {
            HeadV1::Present(result) => result.path_ref = 1,
            HeadV1::Absent { .. } => unreachable!("receiver result is present"),
        }
        payload.incoming = result.clone();
        payload.result = result;
        payload.effects = vec![
            EffectV1 {
                kind: EffectKindV1::Delete,
                moment_id: "moment-delete".to_owned(),
                payload_sha256: String::new(),
            },
            EffectV1 {
                kind: EffectKindV1::Write,
                moment_id: "moment-result".to_owned(),
                payload_sha256: String::new(),
            },
        ];
        let built = build_conflict_resolve_v1(payload).expect("path-change carrier");
        (scratch, store, key, built)
    }

    fn moved_object_receiver_fixture() -> (
        ScratchDir,
        EngineStore,
        DocKey,
        DocKey,
        BuiltConflictResolveV1,
    ) {
        let (scratch, store, current_key, built) = path_change_receiver_fixture();
        let mut payload = built.validated.payload;
        for head in [&mut payload.incoming, &mut payload.result] {
            let HeadV1::Present(head) = head else {
                panic!("moved result is present");
            };
            head.object_id = "object-b".to_owned();
        }
        payload.effect_context.result_object_created_at_ms = Some(11);
        payload
            .lineage_transition
            .as_mut()
            .expect("moved current archives its lineage")
            .successor = None;
        let built = build_conflict_resolve_v1(payload).expect("moved-object carrier");
        let result_key = DocKey::new("ws", "main", "object-b").expect("result key");
        (scratch, store, current_key, result_key, built)
    }

    fn absent_result_receiver_fixture() -> (ScratchDir, EngineStore, DocKey, BuiltConflictResolveV1)
    {
        let (scratch, store, key, built) = receiver_fixture();
        let mut payload = built.validated.payload;
        payload.incoming = HeadV1::Absent { path_ref: 0 };
        payload.result = HeadV1::Absent { path_ref: 0 };
        payload.effect_context.result_object_created_at_ms = None;
        payload.effects = vec![EffectV1 {
            kind: EffectKindV1::Delete,
            moment_id: "moment-delete".to_owned(),
            payload_sha256: String::new(),
        }];
        payload
            .lineage_transition
            .as_mut()
            .expect("lineage transition")
            .successor = None;
        let built = build_conflict_resolve_v1(payload).expect("absent-result carrier");
        (scratch, store, key, built)
    }

    fn binary_result_receiver_fixture() -> (
        ScratchDir,
        EngineStore,
        DocKey,
        BuiltConflictResolveV1,
        Vec<u8>,
    ) {
        let (scratch, store, key, built) = receiver_fixture();
        let bytes = b"\0resolved binary\xff".to_vec();
        let binary_sha = store.put_binary_blob(&bytes).expect("binary result blob");
        let mut payload = built.validated.payload;
        let result = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-a".to_owned(),
            latest_moment_id: "moment-result".to_owned(),
            content_kind: HeadContentKindV1::Binary,
            blob_sha256: binary_sha,
            byte_length: i64::try_from(bytes.len()).expect("binary length"),
            updated_at_ms: 21,
        });
        payload.incoming = result.clone();
        payload.result = result;
        payload.effects = vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "moment-result".to_owned(),
            payload_sha256: String::new(),
        }];
        payload
            .lineage_transition
            .as_mut()
            .expect("lineage transition")
            .successor = None;
        let built = build_conflict_resolve_v1(payload).expect("binary-result carrier");
        (scratch, store, key, built, bytes)
    }

    fn imported_envelope(seq: i64, kind: &str, payload: Value) -> ReplicationEnvelope {
        ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: seq,
            op_kind: kind.to_owned(),
            payload,
            recorded_at_ms: 21,
        }
    }

    fn matching_keep_current_result(expected: &ConflictResolveV1) -> ResolveTextConflictResult {
        let current_sha = dohc_engine_storage::hex_sha256(b"current text");
        let current = dohc_engine_domain::TextSnapshot {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            object_id: "object-a".to_owned(),
            path: "doc.md".to_owned(),
            text: "current text".to_owned(),
            blob_sha256: current_sha,
            updated_at_ms: 10,
            latest_moment_id: "moment-current".to_owned(),
            metadata_origin: "sync".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
        };
        ResolveTextConflictResult {
            conflict: TextConflict {
                conflict_id: expected.conflict_id.clone(),
                workspace_id: expected.workspace_id.clone(),
                path: "doc.md".to_owned(),
                target_version_id: expected.target_version_id.clone(),
                source_version_id: expected.source_version_id.clone(),
                created_at_ms: 11,
                updated_at_ms: expected.effect_context.recorded_at_ms,
                status: ConflictStatus::Resolved,
                chosen_from: ConflictChoice::Current,
                resolution: Some(ConflictResolution::KeptCurrent),
                metadata: ConflictMetadata::origin("sync"),
                base: ConflictFileState::text("doc.md", None),
                current: ConflictFileState::text("doc.md", Some(current)),
                incoming: ConflictFileState::text("doc.md", None),
            },
            write: None,
            delete: None,
            binary_write: None,
        }
    }

    fn keep_current_expected() -> ConflictResolveV1 {
        let current_sha = dohc_engine_storage::hex_sha256(b"current text");
        let current = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-a".to_owned(),
            latest_moment_id: "moment-current".to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: current_sha,
            byte_length: 12,
            updated_at_ms: 10,
        });
        ConflictResolveV1 {
            workspace_id: "ws".to_owned(),
            conflict_id: "conflict-1".to_owned(),
            chosen_from: ResolveChoiceV1::Current,
            resolution: ResolutionV1::KeptCurrent,
            target_version_id: "main".to_owned(),
            source_version_id: "peer".to_owned(),
            paths: vec!["doc.md".to_owned()],
            current: current.clone(),
            incoming: HeadV1::Absent { path_ref: 0 },
            result: current,
            effect_context: EffectContextV1 {
                recorded_at_ms: 21,
                metadata: MetadataV1 {
                    origin: "sync".to_owned(),
                    summary: None,
                    correlation_id: None,
                },
                author: None,
                current_object_created_at_ms: Some(10),
                result_object_created_at_ms: Some(10),
            },
            effects: Vec::new(),
            lineage_transition: None,
        }
    }

    #[test]
    fn local_result_verifier_rejects_open_or_misbound_conflict_result() {
        let (_scratch, mut store, _key, _built) = receiver_fixture();
        let expected = keep_current_expected();
        let matching = matching_keep_current_result(&expected);
        store
            .write_with(&NoFaults, |tx| {
                verify_local_result_in_tx(tx, &expected, &matching)?;

                let mut open = matching.clone();
                open.conflict.status = ConflictStatus::Open;
                verify_local_result_in_tx(tx, &expected, &open)
                    .expect_err("an open result must not pass resolved-result verification");

                for field in ["workspace", "conflict", "target", "source", "updated-at"] {
                    let mut altered = matching.clone();
                    match field {
                        "workspace" => altered.conflict.workspace_id = "other-workspace".to_owned(),
                        "conflict" => altered.conflict.conflict_id = "other-conflict".to_owned(),
                        "target" => altered.conflict.target_version_id = "other-target".to_owned(),
                        "source" => altered.conflict.source_version_id = "other-source".to_owned(),
                        "updated-at" => altered.conflict.updated_at_ms += 1,
                        _ => unreachable!(),
                    }
                    verify_local_result_in_tx(tx, &expected, &altered)
                        .expect_err("a misbound result must not pass preflight verification");
                }
                Ok::<_, SyncError>(())
            })
            .expect("verify result bindings");
    }

    #[test]
    fn local_result_verifier_rejects_durable_effect_provenance_drift() {
        let (_scratch, mut store, _key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
            .expect("apply exact result");
        let snapshot = VersionedTextStore::new(&mut store)
            .read_text("ws", "main", "doc.md")
            .expect("read result")
            .expect("result head");
        let moment = VersionedTextStore::new(&mut store)
            .list_moments(&ListMomentsQuery {
                workspace_id: "ws".to_owned(),
                version_id: Some("main".to_owned()),
                object_id: Some("object-a".to_owned()),
                limit: 10,
                before_moment_order: None,
            })
            .expect("list moments")
            .moments
            .into_iter()
            .find(|moment| moment.moment_id == "moment-result")
            .expect("result moment");
        let mut result = matching_keep_current_result(&built.validated.payload);
        result.conflict.chosen_from = ConflictChoice::Incoming;
        result.conflict.resolution = Some(ConflictResolution::AppliedIncoming);
        result.write = Some(WriteResult {
            object: FileObjectRecord {
                workspace_id: "ws".to_owned(),
                object_id: "object-a".to_owned(),
                created_at_ms: 10,
            },
            snapshot,
            moment,
            deduped: false,
        });
        result.binary_write = None::<BinaryResolveWrite>;

        store
            .write_with(&NoFaults, |tx| {
                verify_local_result_in_tx(tx, &built.validated.payload, &result)?;
                tx.execute(
                    "UPDATE moments SET recorded_at_ms=22,metadata_origin='api',metadata_summary='wrong',\
                     metadata_correlation_id='wrong',author_json='{}' \
                     WHERE workspace_id='ws' AND moment_id='moment-result'",
                    [],
                )
                .map_err(SyncError::persist)?;
                verify_local_result_in_tx(tx, &built.validated.payload, &result)
                    .expect_err("durable effect provenance drift must fail verification");
                Ok::<_, SyncError>(())
            })
            .expect("verify durable effect provenance");
    }

    #[test]
    fn exact_parent_applies_result_and_successor_then_child_only_verifies_history() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        let outcome =
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
                .expect("apply parent");
        assert!(matches!(outcome, crate::ApplyOutcome::Applied(_)));
        let (text, latest): (String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text,s.latest_moment_id FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-a'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("result head");
        assert_eq!(
            (text.as_str(), latest.as_str()),
            ("resolved text", "moment-result")
        );
        let marker = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker")
            .expect("successor marker");
        assert_eq!(
            marker.lineage_claim_id.as_deref(),
            built
                .validated
                .payload
                .lineage_transition
                .as_ref()
                .unwrap()
                .successor
                .as_ref()
                .map(|successor| successor.lineage_claim_id.as_str())
        );

        let child = imported_envelope(1, "moment.append", built.validated.shadows[0].clone());
        let moments_before: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("moment count");
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &child, &NoFaults, &crate::NoLiveLeases),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
        let moments_after: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("moment count after child");
        assert_eq!(moments_after, moments_before, "the child is verify-only");
    }

    #[test]
    fn tagged_child_verifies_and_acks_while_the_committed_result_is_live() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
            .expect("apply parent");
        let before: (String, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT latest_moment_id FROM snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='object-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                ))
            })
            .expect("state before child");
        let marker_before = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker before child")
            .and_then(|marker| marker.lineage_claim_id);
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let _held = leases.acquire(&key).expect("hold committed result live");
        let child = imported_envelope(1, "moment.append", built.validated.shadows[0].clone());
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &child, &NoFaults, &leases),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
        let after: (String, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT latest_moment_id FROM snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='object-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                ))
            })
            .expect("state after child");
        assert_eq!(
            after, before,
            "the live tagged child must remain verify-only"
        );
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .expect("marker after child")
                .and_then(|marker| marker.lineage_claim_id),
            marker_before,
            "the tagged child must not rewrite the live lineage",
        );
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("child ack"),
            1
        );
    }

    #[test]
    fn mismatched_and_nonadjacent_tagged_children_hard_fail_without_advancing_their_coordinate() {
        let (_scratch, mut mismatch_store, _key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(
            &mut mismatch_store,
            &parent,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("apply mismatch parent");
        let mut mismatched = built.validated.shadows[0].clone();
        mismatched["metadata"]["summary"] = json!("tampered");
        let child = imported_envelope(1, "moment.append", mismatched);
        assert!(matches!(
            crate::apply_replication_envelope(
                &mut mismatch_store,
                &child,
                &NoFaults,
                &crate::NoLiveLeases,
            ),
            Err(SyncError::CoordinateDiverged)
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&mismatch_store, "ws", "peer").expect("mismatch ack"),
            0
        );

        let (_scratch, mut nonadjacent_store, _key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(
            &mut nonadjacent_store,
            &parent,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("apply nonadjacent parent");
        let intervening = imported_envelope(1, "future.operation", json!({"ignored": true}));
        assert!(matches!(
            crate::apply_replication_envelope(
                &mut nonadjacent_store,
                &intervening,
                &NoFaults,
                &crate::NoLiveLeases,
            ),
            Ok(crate::ApplyOutcome::Refused(_))
        ));
        let child = imported_envelope(2, "moment.append", built.validated.shadows[0].clone());
        assert!(matches!(
            crate::apply_replication_envelope(
                &mut nonadjacent_store,
                &child,
                &NoFaults,
                &crate::NoLiveLeases,
            ),
            Err(SyncError::CoordinateDiverged)
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&nonadjacent_store, "ws", "peer")
                .expect("nonadjacent ack"),
            1
        );
    }

    #[test]
    fn untagged_shadow_remains_an_ordinary_moment_apply() {
        let (_scratch, mut store, _key, built) = receiver_fixture();
        store
            .write_with(&NoFaults, |tx| {
                crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object-a")
            })
            .expect("retire the main-only fixture lineage");
        let mut payload = built.validated.shadows[0].clone();
        let record = payload.as_object_mut().expect("moment shadow object");
        record.remove("conflictId");
        record.remove("conflictEffectIndex");
        let moment = imported_envelope(0, "moment.append", payload);
        let outcome =
            crate::apply_replication_envelope(&mut store, &moment, &NoFaults, &crate::NoLiveLeases);
        assert!(
            matches!(outcome, Ok(crate::ApplyOutcome::Applied(_))),
            "unexpected untagged moment outcome: {outcome:?}",
        );
        let (text, latest): (String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text,s.latest_moment_id FROM snapshots s \
                     JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-a'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("ordinary moment result");
        assert_eq!(
            (text.as_str(), latest.as_str()),
            ("resolved text", "moment-result")
        );
    }

    #[test]
    fn incomplete_lineage_retries_the_parent_without_ack_or_effects() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let dependent_doc = dohc_engine_collab::Ydoc::wire();
        let _predecessor = dependent_doc.plaintext_insert(0, "dependency");
        let dependent = dependent_doc.plaintext_insert(0, "more ");
        let dependent_sha = store.put_binary_blob(&dependent).expect("dependent update");
        let update = ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "dependency-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "object-a",
                "path": "doc.md",
                "contentKind": "plaintext",
                "updateBlobSha256": dependent_sha,
                "isBaseState": false,
            }),
            recorded_at_ms: 20,
        };
        crate::apply_ydoc_envelope(&mut store, &update, &NoFaults, &crate::NoLiveLeases)
            .expect("park dependent update");
        assert!(
            dohc_engine_collab::load_persisted(&store, &key)
                .expect("load lineage")
                .expect("active lineage")
                .doc
                .has_pending_dependencies()
        );
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases,),
            Err(SyncError::RetryableState {
                reason: "ydoc-incomplete-lineage"
            })
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("parent ack"),
            -1
        );
        let (latest, effect_rows): (String, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT latest_moment_id FROM snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='object-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='moment-result'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("state after retry");
        assert_eq!((latest.as_str(), effect_rows), ("moment-current", 0));
    }

    #[test]
    fn path_change_reports_delete_then_write_on_first_delivery_and_replays_record_only() {
        let (_scratch, mut store, _key, built) = path_change_receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
            .expect("apply path-change parent");
        let changes = crate::conflict_apply::redelivered_materialization_changes(&store, &parent)
            .expect("first-delivery materialization changes");
        assert_eq!(
            changes
                .iter()
                .map(|change| (change.operation, change.path.as_str()))
                .collect::<Vec<_>>(),
            [("delete", "doc.md"), ("write", "moved.md")]
        );
        let text = VersionedTextStore::new(&mut store);
        assert!(
            text.read_text("ws", "main", "doc.md")
                .expect("old path")
                .is_none()
        );
        assert_eq!(
            text.read_text("ws", "main", "moved.md")
                .expect("moved path")
                .expect("moved result")
                .text,
            "resolved text"
        );
        let moments_before: i64 = store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .expect("moments before replay");
        let mut replay = imported_envelope(0, "conflict.resolve", built.value.clone());
        replay.origin_id = "other-peer".to_owned();
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &replay, &NoFaults, &crate::NoLiveLeases,),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
        let moments_after: i64 = store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .expect("moments after replay");
        assert_eq!(moments_after, moments_before);
        let (open_reviews, conflicting_successors): (i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws' AND status='open'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE workspace_id='ws' \
                         AND disposition='conflicting-successor'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("path replay disposition");
        assert_eq!(
            (open_reviews, conflicting_successors),
            (0, 0),
            "an already-applied move must not be reclassified as divergence",
        );
    }

    #[test]
    fn absent_and_binary_results_archive_the_lineage_and_replay_record_only() {
        let (_scratch, mut absent_store, absent_key, absent_built) =
            absent_result_receiver_fixture();
        let absent_parent = imported_envelope(0, "conflict.resolve", absent_built.value.clone());
        crate::apply_replication_envelope(
            &mut absent_store,
            &absent_parent,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("apply absent result");
        assert!(
            VersionedTextStore::new(&mut absent_store)
                .read_text("ws", "main", "doc.md")
                .expect("deleted path")
                .is_none()
        );
        assert!(
            dohc_engine_collab::read_marker(&absent_store, &absent_key)
                .expect("absent marker")
                .is_none()
        );
        let mut absent_replay =
            imported_envelope(0, "conflict.resolve", absent_built.value.clone());
        absent_replay.origin_id = "other-peer".to_owned();
        let outcome = crate::apply_replication_envelope(
            &mut absent_store,
            &absent_replay,
            &NoFaults,
            &crate::NoLiveLeases,
        );
        assert!(
            matches!(outcome, Ok(crate::ApplyOutcome::Applied(_))),
            "unexpected absent replay outcome: {outcome:?}",
        );

        let (_scratch, mut binary_store, binary_key, binary_built, bytes) =
            binary_result_receiver_fixture();
        let binary_parent = imported_envelope(0, "conflict.resolve", binary_built.value.clone());
        crate::apply_replication_envelope(
            &mut binary_store,
            &binary_parent,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("apply binary result");
        let (kind, sha, latest): (String, String, String) = binary_store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT content_kind,binary_sha256,latest_moment_id FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='main' AND object_id='object-a'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .expect("binary result head");
        assert_eq!(kind, "binary");
        assert_eq!(sha, dohc_engine_storage::hex_sha256(&bytes));
        assert_eq!(latest, "moment-result");
        assert!(
            dohc_engine_collab::read_marker(&binary_store, &binary_key)
                .expect("binary marker")
                .is_none()
        );
        let mut binary_replay =
            imported_envelope(0, "conflict.resolve", binary_built.value.clone());
        binary_replay.origin_id = "other-peer".to_owned();
        assert!(matches!(
            crate::apply_replication_envelope(
                &mut binary_store,
                &binary_replay,
                &NoFaults,
                &crate::NoLiveLeases,
            ),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
    }

    #[test]
    fn orphan_tagged_child_is_a_hard_unacked_failure() {
        let (_scratch, mut store, _key, built) = receiver_fixture();
        let child = imported_envelope(0, "moment.append", built.validated.shadows[0].clone());
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &child, &NoFaults, &crate::NoLiveLeases),
            Err(SyncError::CoordinateDiverged)
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            -1
        );
    }

    #[test]
    fn live_parent_retries_without_ack_or_mutation_then_applies_after_close() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let held = leases.acquire(&key).expect("hold live");
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &leases),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            -1
        );
        let live_text: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-a'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("live head");
        assert_eq!(live_text, "current text");
        drop(held);
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &leases),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("retry ack"),
            0
        );
    }

    #[test]
    fn lineage_unbound_parent_preserves_a_claimed_receiver_for_review() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let mut payload = built.validated.payload;
        payload.lineage_transition = None;
        let built = build_conflict_resolve_v1(payload).expect("lineage-unbound carrier");
        let parent = imported_envelope(0, "conflict.resolve", built.value);

        crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
            .expect("apply lineage-unbound parent");

        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "doc.md")
                .expect("current head")
                .expect("current head remains")
                .text,
            "current text",
        );
        let open_reviews: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws' AND status='open'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })
            .expect("open review count");
        assert_eq!(open_reviews, 1);

        assert_eq!(projected_ydoc_text(&mut store, &key), "current text");
    }

    #[test]
    fn lineage_unbound_parent_rewrites_an_unclaimed_receivers_closed_ydoc() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![key.workspace_id, key.version_id, key.object_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("remove claimed receiver lineage");
        dohc_engine_collab::ensure_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            dohc_engine_collab::Regime::LocalOnly,
            &NoFaults,
            12,
        )
        .expect("unclaimed marker");
        let doc = dohc_engine_collab::Ydoc::wire();
        let update = doc.plaintext_insert(0, "current text");
        dohc_engine_collab::record_local_update(&mut store, &key, &update, &NoFaults, 13)
            .expect("unclaimed receiver content");

        let mut payload = built.validated.payload;
        payload.lineage_transition = None;
        let built = build_conflict_resolve_v1(payload).expect("lineage-unbound carrier");
        let parent = imported_envelope(0, "conflict.resolve", built.value);

        crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
            .expect("apply lineage-unbound parent");

        assert_eq!(projected_ydoc_text(&mut store, &key), "resolved text");
    }

    fn projected_ydoc_text(store: &mut EngineStore, key: &DocKey) -> String {
        let marker = dohc_engine_collab::read_marker(store, key)
            .expect("read receiver marker")
            .expect("receiver lineage remains present");
        let projected = store
            .write_with(&NoFaults, |tx| {
                let doc =
                    dohc_engine_collab::load_doc_in_tx(tx, key).map_err(map_local_collab_error)?;
                doc.project(marker.content_kind)
                    .map(|projection| projection.markdown)
                    .map_err(map_local_collab_error)
            })
            .expect("project receiver Y.Doc");
        let dohc_engine_storage::TxnOutcome::Committed(projected) = projected else {
            panic!("projection transaction cannot crash without an injected fault");
        };
        projected
    }

    #[test]
    fn moved_result_retries_while_its_destination_ydoc_is_live() {
        let (_scratch, mut store, _current_key, result_key, built) =
            moved_object_receiver_fixture();
        let parent = imported_envelope(0, "conflict.resolve", built.value);
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let destination = derive_capture_object_id("ws", "main", "moved.md");
        assert_ne!(destination, result_key.object_id);
        let destination_key = DocKey::new("ws", "main", destination).expect("destination key");
        let _held = leases
            .acquire(&destination_key)
            .expect("hold absent destination live");

        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &leases),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            -1,
        );
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "doc.md")
                .expect("current path")
                .is_some(),
            "the destination lease must refuse before deleting the current head",
        );
    }

    #[test]
    fn divergent_parent_preserves_active_head_and_archives_incoming_successor_for_review() {
        let (_scratch, mut store, key, built) = receiver_fixture();
        let active_claim_before = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker")
            .expect("active")
            .lineage_claim_id;
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-a".to_owned(),
                    path: "doc.md".to_owned(),
                    text: "local newer".to_owned(),
                    moment_id: "moment-local-newer".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("advance local head");
        let parent = imported_envelope(0, "conflict.resolve", built.value.clone());
        let outcome =
            crate::apply_replication_envelope(&mut store, &parent, &NoFaults, &crate::NoLiveLeases)
                .expect("preserve divergent result");
        assert!(matches!(outcome, crate::ApplyOutcome::Applied(_)));
        let (text, latest, open, inactive): (String, String, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                         WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT latest_moment_id FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id='object-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws' AND status='open' AND metadata_origin='sync'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE workspace_id='ws' AND disposition='conflicting-successor'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("divergence state");
        assert_eq!(
            (text.as_str(), latest.as_str()),
            ("local newer", "moment-local-newer")
        );
        assert_eq!((open, inactive), (1, 1));
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .expect("marker after")
                .expect("active after")
                .lineage_claim_id,
            active_claim_before,
            "the active lineage must remain untouched"
        );
    }

    #[test]
    fn already_result_parent_is_record_only_and_idempotent_across_origins() {
        let (_scratch, mut store, _key, built) = receiver_fixture();
        let first = imported_envelope(0, "conflict.resolve", built.value.clone());
        crate::apply_replication_envelope(&mut store, &first, &NoFaults, &crate::NoLiveLeases)
            .expect("first parent");
        let before: (i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM ydoc_inactive_lineages", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .expect("before replay");
        let mut second = imported_envelope(0, "conflict.resolve", built.value.clone());
        second.origin_id = "other-peer".to_owned();
        assert!(matches!(
            crate::apply_replication_envelope(&mut store, &second, &NoFaults, &crate::NoLiveLeases),
            Ok(crate::ApplyOutcome::Applied(_))
        ));
        let after: (i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM ydoc_inactive_lineages", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .expect("after replay");
        assert_eq!(after, before);
    }

    #[test]
    fn already_result_parent_rejects_drifted_durable_shadow_provenance() {
        for (column, value) in [
            ("metadata_origin", "'api'"),
            ("metadata_summary", "'drifted'"),
            ("metadata_correlation_id", "'drifted'"),
            ("author_json", "'{}'"),
            ("before_present", "1"),
        ] {
            let (_scratch, mut store, _key, built) = receiver_fixture();
            let first = imported_envelope(0, "conflict.resolve", built.value.clone());
            crate::apply_replication_envelope(&mut store, &first, &NoFaults, &crate::NoLiveLeases)
                .expect("first parent");
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        &format!(
                            "UPDATE moments SET {column}={value} \
                             WHERE workspace_id='ws' AND moment_id='moment-result'"
                        ),
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("drift durable shadow");
            let mut replay = imported_envelope(0, "conflict.resolve", built.value.clone());
            replay.origin_id = format!("{column}-peer");
            assert!(
                matches!(
                    crate::apply_replication_envelope(
                        &mut store,
                        &replay,
                        &NoFaults,
                        &crate::NoLiveLeases,
                    ),
                    Err(SyncError::CoordinateDiverged)
                ),
                "already-result replay accepted drift in {column}",
            );
            assert_eq!(
                crate::read_replication_acked_seq(&store, "ws", &replay.origin_id)
                    .expect("drifted replay ack"),
                -1,
            );
        }
    }

    #[test]
    fn strict_v1_carrier_matches_the_relay_shadow_vectors() {
        let payload = compact_path_change();
        let validated = validate_conflict_resolve_v1(
            &payload,
            ConflictResolveEnvelopeContext {
                workspace_id: "workspace-a",
                recorded_at_ms: 21,
            },
        )
        .expect("strict D-double-prime carrier");

        assert_eq!(validated.shadows.len(), 2);
        assert_eq!(validated.shadows[0]["conflictId"], "conflict-1");
        assert_eq!(validated.shadows[0]["conflictEffectIndex"], 0);
        assert_eq!(validated.shadows[0]["beforeMetadata"], Value::Null);
        assert_eq!(validated.shadows[1]["conflictEffectIndex"], 1);
        assert_eq!(validated.shadows[1]["beforeMetadata"], Value::Null);
        assert_eq!(
            validated.shadow_sha256s,
            [
                "8b196309f6d6a69295119febd37fa5d090b09df28d4faff97a238735729ddcd8",
                "a605f5800e5591dd9700a75790bebf15de053df6158ec2433258e479ac034ab0",
            ]
        );
    }

    #[test]
    fn lineage_artifact_preimage_mismatch_is_refused_without_mutating_input() {
        let mut payload = compact_path_change();
        payload["lineageTransition"]["artifactPreimageSha256"] = json!("d".repeat(64));
        let before = payload.clone();

        let error = validate_conflict_resolve_v1(
            &payload,
            ConflictResolveEnvelopeContext {
                workspace_id: "workspace-a",
                recorded_at_ms: 21,
            },
        )
        .expect_err("a successor CAS must bind the exact current artifact");

        assert!(matches!(
            error,
            SyncError::InvalidInput {
                reason: "conflict.resolve lineage artifact preimage does not match current"
            }
        ));
        assert_eq!(payload, before);
    }

    fn max_identifier(suffix: char) -> String {
        format!("{}{suffix}", "\"".repeat(MAX_IDENTIFIER_BYTES - 1))
    }

    fn max_path(suffix: char) -> String {
        format!(
            "{}{suffix}",
            "\"".repeat(MAX_CANONICAL_WORKSPACE_PATH_BYTES - 1)
        )
    }

    #[test]
    fn measured_worst_healthy_v1_carrier_fits_with_named_slack() {
        let current_sha = "a".repeat(64);
        let result_sha = "b".repeat(64);
        let successor_sha = "c".repeat(64);
        let state_vector_sha = "d".repeat(64);
        let current_object_id = max_identifier('o');
        let delete_moment_id = max_identifier('d');
        let write_moment_id = max_identifier('w');
        let path_a = max_path('a');
        let path_b = max_path('b');
        assert_eq!(path_a.len(), MAX_CANONICAL_WORKSPACE_PATH_BYTES);
        assert_eq!(path_b.len(), MAX_CANONICAL_WORKSPACE_PATH_BYTES);
        let metadata_field = "\0".repeat(dohc_engine_domain::MAX_METADATA_FIELD_BYTES);
        let author_field = max_identifier('a');
        let payload = ConflictResolveV1 {
            workspace_id: max_identifier('x'),
            conflict_id: max_identifier('c'),
            chosen_from: ResolveChoiceV1::Incoming,
            resolution: ResolutionV1::AppliedIncoming,
            target_version_id: max_identifier('t'),
            source_version_id: max_identifier('s'),
            paths: vec![path_a, path_b],
            current: HeadV1::Present(PresentHeadV1 {
                path_ref: 0,
                object_id: current_object_id.clone(),
                latest_moment_id: max_identifier('l'),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: current_sha.clone(),
                byte_length: MAX_WIRE_INTEGER,
                updated_at_ms: MAX_WIRE_INTEGER,
            }),
            incoming: HeadV1::Present(PresentHeadV1 {
                path_ref: 1,
                object_id: max_identifier('p'),
                latest_moment_id: max_identifier('i'),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: result_sha.clone(),
                byte_length: MAX_WIRE_INTEGER,
                updated_at_ms: MAX_WIRE_INTEGER,
            }),
            result: HeadV1::Present(PresentHeadV1 {
                path_ref: 1,
                object_id: current_object_id,
                latest_moment_id: write_moment_id.clone(),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: result_sha.clone(),
                byte_length: MAX_WIRE_INTEGER,
                updated_at_ms: MAX_WIRE_INTEGER,
            }),
            effect_context: EffectContextV1 {
                recorded_at_ms: MAX_WIRE_INTEGER,
                metadata: MetadataV1 {
                    origin: "api".to_owned(),
                    summary: Some(metadata_field.clone()),
                    correlation_id: Some(metadata_field),
                },
                author: Some(AgentAuthorV1 {
                    agent_id: author_field.clone(),
                    on_behalf_of: author_field.clone(),
                    agent_run_id: Some(author_field),
                }),
                current_object_created_at_ms: Some(MAX_WIRE_INTEGER),
                result_object_created_at_ms: Some(MAX_WIRE_INTEGER),
            },
            effects: vec![
                EffectV1 {
                    kind: EffectKindV1::Delete,
                    moment_id: delete_moment_id,
                    payload_sha256: String::new(),
                },
                EffectV1 {
                    kind: EffectKindV1::Write,
                    moment_id: write_moment_id,
                    payload_sha256: String::new(),
                },
            ],
            lineage_transition: Some(LineageTransitionV1 {
                predecessor_claim_id: "e".repeat(64),
                predecessor_state_vector_sha256: "f".repeat(64),
                artifact_preimage_sha256: current_sha,
                successor: Some(SuccessorV1 {
                    lineage_claim_id: successor_sha.clone(),
                    epoch_tag: "1".repeat(64),
                    content_kind: SuccessorContentKindV1::Plaintext,
                    result_sha256: result_sha,
                    update_blob_sha256: successor_sha,
                    state_vector_blob_sha256: state_vector_sha,
                }),
            }),
        };

        let built = build_conflict_resolve_v1(payload).expect("measured healthy carrier");
        let shadow_sizes = built
            .validated
            .shadows
            .iter()
            .map(|shadow| crate::relay::canonical_json_bytes(shadow).unwrap().len())
            .collect::<Vec<_>>();
        eprintln!(
            "D-double-prime measured bytes: outer={}, shadows={shadow_sizes:?}, slack={}",
            built.validated.encoded_payload_bytes,
            MAX_PAYLOAD_JSON_BYTES - built.validated.encoded_payload_bytes
        );
        assert_eq!(built.validated.encoded_payload_bytes, 218_223);
        assert_eq!(shadow_sizes, [216_040, 208_719]);
        assert_eq!(
            MAX_PAYLOAD_JSON_BYTES - built.validated.encoded_payload_bytes,
            43_921
        );
    }

    #[test]
    fn path_limit_error_names_constraint_limit_and_observed_bytes() {
        let mut payload = compact_path_change();
        payload["paths"][1] = json!("a".repeat(MAX_CANONICAL_WORKSPACE_PATH_BYTES + 1));
        let error = validate_conflict_resolve_v1(
            &payload,
            ConflictResolveEnvelopeContext {
                workspace_id: "workspace-a",
                recorded_at_ms: 21,
            },
        )
        .expect_err("over-limit canonical path");
        assert!(matches!(
            error,
            SyncError::InputTooLarge {
                constraint: "MAX_CANONICAL_WORKSPACE_PATH_BYTES",
                limit_bytes: MAX_CANONICAL_WORKSPACE_PATH_BYTES,
                observed_bytes: 1_025,
            }
        ));
    }

    #[test]
    fn local_author_rejects_unknown_fields() {
        let error = local_author(Some(
            r#"{"kind":"agent","agentId":"agent-1","onBehalfOf":"user-1","unexpected":true}"#,
        ))
        .expect_err("unknown author fields must not be silently dropped");

        assert!(matches!(
            error,
            SyncError::InvalidInput {
                reason: "conflict.resolve author has unknown fields"
            }
        ));
    }

    #[test]
    fn local_carrier_origin_rejects_non_wire_values() {
        assert!(matches!(
            local_replicated_moment_origin("test"),
            Err(SyncError::InvalidInput {
                reason: "conflict.resolve metadata origin is invalid"
            })
        ));
        assert_eq!(
            local_replicated_moment_origin("ydoc").expect("ydoc origin"),
            "local-file"
        );
    }
}
