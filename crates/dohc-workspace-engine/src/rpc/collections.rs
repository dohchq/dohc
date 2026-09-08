use crate::EngineService;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use dohc_engine_domain::CollectionFilter;
use dohc_engine_domain::CollectionPendingAdoptionCursor;
use dohc_engine_domain::CollectionQuery;
use dohc_engine_domain::CollectionQueryCursor;
use dohc_engine_domain::CollectionQueryResult;
use dohc_engine_domain::CollectionSort;
use dohc_engine_domain::DEFAULT_COLLECTION_QUERY_LIMIT;
use dohc_engine_domain::MAX_COLLECTION_FIELD_VALUE_DEPTH;
use dohc_engine_domain::MAX_COLLECTION_HISTORY_LIMIT;
use dohc_engine_domain::MAX_COLLECTION_QUERY_LIMIT;
use dohc_engine_domain::MAX_COLLECTION_QUERY_SORTS;
use dohc_engine_domain::collection_value_exceeds_depth;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

const COLLECTION_RESPONSE_HARD_CAP_BYTES: usize =
    dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize - 64 * 1024;

const COLLECTION_INTEGER_MARKER: &str = "$dohcInt64";

const COLLECTION_FLOAT_MARKER: &str = "$dohcFloat64";

fn is_collection_marker_spelling(marker: &str) -> bool {
    let Some(marker) = marker.strip_prefix('$') else {
        return false;
    };
    matches!(marker.trim_start_matches('$'), "dohcInt64" | "dohcFloat64")
}

fn unescape_collection_marker_key(marker: &str) -> Option<&str> {
    (marker.starts_with("$$") && is_collection_marker_spelling(marker)).then(|| &marker[1..])
}

fn canonical_collection_decimal(decimal: &str) -> bool {
    decimal == "0"
        || decimal.strip_prefix('-').is_some_and(|digits| {
            !digits.is_empty()
                && !digits.starts_with('0')
                && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
        || (!decimal.starts_with('0') && decimal.bytes().all(|byte| byte.is_ascii_digit()))
}

fn encode_collection_wire_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let marker = if number.is_f64() {
                number.as_f64().and_then(|number| {
                    (number.is_finite()
                        && number.fract() == 0.0
                        && number.abs() > dohc_engine_protocol::MAX_WIRE_INTEGER as f64)
                        .then(|| (COLLECTION_FLOAT_MARKER, format!("{number:.0}")))
                })
            } else {
                number
                    .as_i64()
                    .filter(|number| number.unsigned_abs() > dohc_engine_protocol::MAX_WIRE_INTEGER)
                    .map(|number| (COLLECTION_INTEGER_MARKER, number.to_string()))
                    .or_else(|| {
                        number
                            .as_u64()
                            .filter(|number| *number > dohc_engine_protocol::MAX_WIRE_INTEGER)
                            .map(|number| (COLLECTION_INTEGER_MARKER, number.to_string()))
                    })
            };
            if let Some((marker, decimal)) = marker {
                *value = json!({ (marker): decimal });
            }
        }
        Value::Array(values) => values.iter_mut().for_each(encode_collection_wire_numbers),
        Value::Object(object) => {
            object.values_mut().for_each(encode_collection_wire_numbers);
            let marker = (object.len() == 1)
                .then(|| object.keys().next())
                .flatten()
                .filter(|key| is_collection_marker_spelling(key))
                .cloned();
            if let Some(marker) = marker {
                let child = object.remove(&marker).expect("singleton marker child");
                object.insert(format!("${marker}"), child);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn decode_collection_wire_numbers(value: &mut Value) -> Result<(), WireError> {
    match value {
        Value::Array(values) => {
            for value in values {
                decode_collection_wire_numbers(value)?;
            }
        }
        Value::Object(object) => {
            let escaped_marker = (object.len() == 1)
                .then(|| object.keys().next())
                .flatten()
                .and_then(|key| {
                    unescape_collection_marker_key(key)
                        .map(|unescaped| (key.clone(), unescaped.to_owned()))
                });
            if let Some((marker, unescaped)) = escaped_marker {
                let mut child = object
                    .remove(&marker)
                    .expect("singleton escaped marker child");
                decode_collection_wire_numbers(&mut child)?;
                object.insert(unescaped, child);
            } else if object.len() == 1 && object.contains_key(COLLECTION_INTEGER_MARKER) {
                let decimal = object
                    .get(COLLECTION_INTEGER_MARKER)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        WireError::new(
                            ErrorCode::InvalidParams,
                            "collection-integer-marker-invalid",
                        )
                    })?;
                let canonical = canonical_collection_decimal(decimal);
                let number = if canonical && decimal.starts_with('-') {
                    decimal
                        .parse::<i64>()
                        .ok()
                        .filter(|number| {
                            number.unsigned_abs() > dohc_engine_protocol::MAX_WIRE_INTEGER
                        })
                        .map(Value::from)
                } else if canonical {
                    decimal
                        .parse::<u64>()
                        .ok()
                        .filter(|number| *number > dohc_engine_protocol::MAX_WIRE_INTEGER)
                        .map(Value::from)
                } else {
                    None
                }
                .ok_or_else(|| {
                    WireError::new(
                        ErrorCode::InvalidParams,
                        "collection-integer-marker-invalid",
                    )
                })?;
                *value = number;
            } else if object.len() == 1 && object.contains_key(COLLECTION_FLOAT_MARKER) {
                let decimal = object
                    .get(COLLECTION_FLOAT_MARKER)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        WireError::new(ErrorCode::InvalidParams, "collection-float-marker-invalid")
                    })?;
                let number = canonical_collection_decimal(decimal)
                    .then(|| decimal.parse::<f64>().ok())
                    .flatten()
                    .filter(|number| {
                        number.is_finite()
                            && number.fract() == 0.0
                            && number.abs() > dohc_engine_protocol::MAX_WIRE_INTEGER as f64
                            && format!("{number:.0}") == decimal
                    })
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .ok_or_else(|| {
                        WireError::new(ErrorCode::InvalidParams, "collection-float-marker-invalid")
                    })?;
                *value = number;
            } else {
                for value in object.values_mut() {
                    decode_collection_wire_numbers(value)?;
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn decode_collection_query_wire_numbers(
    params: &mut CollectionsQueryParams,
) -> Result<(), WireError> {
    if let Some(filter) = params.filter.as_mut() {
        decode_collection_wire_numbers(&mut filter.value)?;
    }
    if let Some(cursor) = params.cursor.as_mut() {
        for value in &mut cursor.sort_values {
            decode_collection_wire_numbers(&mut value.value)?;
        }
    }
    Ok(())
}

fn elide_overdepth_collection_values(value: &mut Value) {
    match value {
        Value::Array(values) => values
            .iter_mut()
            .for_each(elide_overdepth_collection_values),
        Value::Object(object) => {
            let value_envelope = object.contains_key("value")
                && (object.contains_key("field")
                    || object.contains_key("records")
                    || object.contains_key("present"));
            for (key, child) in object {
                if value_envelope && key == "value" {
                    if collection_value_exceeds_depth(child, MAX_COLLECTION_FIELD_VALUE_DEPTH) {
                        *child = Value::Null;
                    }
                } else {
                    elide_overdepth_collection_values(child);
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn collection_response_value(response: impl Serialize) -> Result<Value, WireError> {
    let mut response = serde_json::to_value(response)
        .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
    elide_overdepth_collection_values(&mut response);
    encode_collection_wire_numbers(&mut response);
    Ok(response)
}

fn collection_query_response_value(
    mut response: CollectionQueryResult,
) -> Result<Value, WireError> {
    if let Some(cursor) = response.next_cursor.as_mut() {
        for sort_value in &mut cursor.sort_values {
            if sort_value.present
                && collection_value_exceeds_depth(
                    &sort_value.value,
                    MAX_COLLECTION_FIELD_VALUE_DEPTH,
                )
            {
                sort_value.present = false;
                sort_value.value = Value::Null;
            }
        }
    }
    let mut response = serde_json::to_value(response)
        .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
    elide_overdepth_collection_values(&mut response);
    encode_collection_wire_numbers(&mut response);
    Ok(response)
}

/// Approximate serialized-bytes budget for one `collections.getRecord`
/// history page — the same measured discipline as every other list family.
/// Rows carry full previous and next field values, so a row count alone can
/// never bound the frame.
const COLLECTION_HISTORY_PAGE_BYTE_BUDGET: usize = 256 * 1024;

/// Cuts an encoded `collections.getRecord` response's history page to the
/// byte budget and repoints `nextBeforeHistoryId` at the cut, so a caller
/// keeps paging instead of hitting a frame refusal. A single over-budget row
/// still ships (progress guarantee) and rides blob egress when oversized.
fn bound_collection_history_page(response: &mut Value) {
    let Some(history) = response.get_mut("history").and_then(Value::as_array_mut) else {
        return;
    };
    let included = byte_budget_cut_serialized(history, COLLECTION_HISTORY_PAGE_BYTE_BUDGET)
        .max(1)
        .min(history.len());
    if included == history.len() {
        return;
    }
    history.truncate(included);
    let next_before_history_id = history
        .last()
        .map_or(Value::Null, |row| row["historyId"].clone());
    response["nextBeforeHistoryId"] = next_before_history_id;
}

/// Approximate serialized-bytes budget for one `collections.list` page.
const COLLECTIONS_PAGE_BYTE_BUDGET: usize = 256 * 1024;

/// The most one summary's serialized degradation-reason list may occupy in a
/// `collections.list` page. The reason COUNT is capped at the wire collection
/// limit, but 16,384 reasons with long paths can still pass the frame; the
/// full list stays readable through `collections.get`, which rides blob
/// egress.
const COLLECTION_SUMMARY_REASONS_BYTE_BUDGET: usize = 64 * 1024;

/// Bounds an encoded `collections.list` page by serialized bytes: each
/// summary's reason list truncates to its budget with an `omittedReasons`
/// count, then the page cuts to its budget and `nextCursor` repoints at the
/// cut so a caller keeps paging instead of hitting a frame refusal.
fn bound_collections_list_page(response: &mut Value) {
    let Some(collections) = response
        .get_mut("collections")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for summary in collections.iter_mut() {
        let Some(reasons) = summary.get_mut("reasons").and_then(Value::as_array_mut) else {
            continue;
        };
        let included = byte_budget_cut_serialized(reasons, COLLECTION_SUMMARY_REASONS_BYTE_BUDGET);
        if included < reasons.len() {
            let omitted = reasons.len() - included;
            reasons.truncate(included);
            summary["omittedReasons"] = json!(omitted);
        }
    }
    let included = byte_budget_cut_serialized(collections, COLLECTIONS_PAGE_BYTE_BUDGET)
        .max(1)
        .min(collections.len());
    if included < collections.len() {
        collections.truncate(included);
        let next_cursor = collections
            .last()
            .map_or(Value::Null, |summary| summary["path"].clone());
        response["nextCursor"] = next_cursor;
    }
}

/// This request's in-band collection response cap: the negotiated client
/// frame minus envelope headroom, never above the engine default cap. The
/// hello clamp keeps the negotiated frame at 1 MiB or more, so the cap always
/// clears the single-row hard cap and page byte budgets.
pub(super) fn collection_in_band_cap(ctx: &RequestContext) -> usize {
    (ctx.max_frame_bytes as usize)
        .saturating_sub(64 * 1024)
        .min(COLLECTION_RESPONSE_HARD_CAP_BYTES)
}

fn in_band_collection_response(response: Value, cap: usize) -> Result<Value, WireError> {
    let encoded_len = serde_json::to_vec(&response)
        .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?
        .len();
    if encoded_len > cap {
        return Err(WireError::new(
            ErrorCode::LimitExceeded,
            "collection-response-exceeds-wire-limit",
        ));
    }
    Ok(response)
}

fn collection_response_json(
    response: impl Serialize,
    ctx: &RequestContext,
) -> Result<Value, WireError> {
    in_band_collection_response(
        collection_response_value(response)?,
        collection_in_band_cap(ctx),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionsListParams {
    #[serde(default = "default_collection_query_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionsListPendingAdoptionsParams {
    #[serde(default = "default_collection_query_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<CollectionPendingAdoptionCursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionsGetParams {
    collection_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionsQueryParams {
    collection_path: String,
    #[serde(default)]
    filter: Option<CollectionFilter>,
    #[serde(default)]
    sort: Vec<CollectionSort>,
    #[serde(default)]
    group_by: Option<String>,
    #[serde(default)]
    resolve_relations: bool,
    #[serde(default = "default_collection_query_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<CollectionQueryCursor>,
}

fn default_collection_query_limit() -> usize {
    DEFAULT_COLLECTION_QUERY_LIMIT
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionsGetRecordParams {
    collection_path: String,
    record_id: String,
    history_limit: usize,
    before_history_id: Option<i64>,
}

impl EngineService {
    async fn collection_response_with_blob(
        &self,
        ctx: &RequestContext,
        cancellation: &OperationCancellation,
        request_id: u64,
        operation: &str,
        response: Value,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let cap = collection_in_band_cap(ctx);
        let bytes = serde_json::to_vec(&response)
            .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
        if bytes.len() <= cap {
            return Ok((response, None));
        }
        if bytes.len() > dohc_engine_storage::MAX_BLOB_BYTES || !ctx.has_capability("blobs") {
            return Err(WireError::new(
                ErrorCode::LimitExceeded,
                "collection-response-exceeds-wire-limit",
            ));
        }
        let byte_length = i64::try_from(bytes.len())
            .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
        let byte_permit = self
            .blob_egress_budget
            .reserve(byte_length, cancellation, operation)
            .await?;
        let sha256 = dohc_engine_storage::hex_sha256(&bytes);
        Ok((
            json!({
                "collectionJson": Value::Null,
                "blobSha256": sha256,
                "byteLength": byte_length,
                "inbandLimitBytes": cap,
            }),
            Some(BlobEgress {
                stream_id: request_id,
                sha256,
                bytes,
                cancel: ctx.cancel.clone(),
                deadline: ctx.deadline,
                byte_permit: Some(byte_permit),
            }),
        ))
    }

    /// Returns one path-ordered page of the workspace's active-version
    /// collections with an exclusive continuation cursor.
    pub(super) async fn collections_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CollectionsListParams = parse(params)?;
        if params.limit == 0 || params.limit > MAX_COLLECTION_QUERY_LIMIT {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "collection-list-limit-out-of-range",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "collections.list",
            open.actor
                .collections_list(open.workspace_id.clone(), params.limit, params.cursor),
        )
        .await?;
        let mut response = collection_response_value(page)?;
        bound_collections_list_page(&mut response);
        in_band_collection_response(response, collection_in_band_cap(ctx))
    }

    /// Returns active-version collection bindings waiting for the shared
    /// rich-document importer to establish canonical Y.Doc lineage.
    pub(super) async fn collections_list_pending_adoptions(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CollectionsListPendingAdoptionsParams = parse(params)?;
        if params.limit == 0 || params.limit > MAX_COLLECTION_QUERY_LIMIT {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "collection-pending-adoptions-limit-out-of-range",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "collections.listPendingAdoptions",
            open.actor.collections_list_pending_adoptions(
                open.workspace_id.clone(),
                params.limit,
                params.cursor,
            ),
        )
        .await?;
        collection_response_json(page, ctx)
    }

    pub(super) async fn collections_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: CollectionsGetParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let collection = Self::read_under_ctx(
            &cancellation,
            "collections.get",
            open.actor
                .collections_get(open.workspace_id.clone(), params.collection_path),
        )
        .await?
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "collection-not-found"))?;
        self.collection_response_with_blob(
            ctx,
            &cancellation,
            request_id,
            "collections.get",
            collection_response_value(collection)?,
        )
        .await
    }

    pub(super) async fn collections_query(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let mut params: CollectionsQueryParams = parse(params)?;
        if params.limit == 0 || params.limit > MAX_COLLECTION_QUERY_LIMIT {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "collection-query-limit-out-of-range",
            ));
        }
        if params.sort.len() > MAX_COLLECTION_QUERY_SORTS {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "collection-query-sort-limit-exceeded",
            ));
        }
        decode_collection_query_wire_numbers(&mut params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = Self::read_under_ctx(
            &cancellation,
            "collections.query",
            open.actor.collections_query_records(
                open.workspace_id.clone(),
                params.collection_path,
                CollectionQuery {
                    filter: params.filter,
                    sort: params.sort,
                    group_by: params.group_by,
                    resolve_relations: params.resolve_relations,
                    limit: params.limit,
                    cursor: params.cursor,
                },
            ),
        )
        .await?
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "collection-not-found"))?;
        self.collection_response_with_blob(
            ctx,
            &cancellation,
            request_id,
            "collections.query",
            collection_query_response_value(result)?,
        )
        .await
    }

    pub(super) async fn collections_get_record(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: CollectionsGetRecordParams = parse(params)?;
        if params.history_limit == 0 || params.history_limit > MAX_COLLECTION_HISTORY_LIMIT {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "collection-history-limit-out-of-range",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = Self::read_under_ctx(
            &cancellation,
            "collections.getRecord",
            open.actor.collections_get_record(
                open.workspace_id.clone(),
                params.collection_path,
                params.record_id,
                params.history_limit,
                params.before_history_id,
            ),
        )
        .await?
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "collection-record-not-found"))?;
        let mut response = collection_response_value(result)?;
        bound_collection_history_page(&mut response);
        self.collection_response_with_blob(
            ctx,
            &cancellation,
            request_id,
            "collections.getRecord",
            response,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::error::ErrorCode;
    use serde_json::Value;
    use serde_json::json;

    #[tokio::test]
    async fn collection_blob_limit_accepts_exact_bytes_and_refuses_oversized_valid_records() {
        use dohc_engine_domain::{
            CollectionFieldValue, CollectionIndexedValue, CollectionIndexedValueValidation,
            CollectionRecord, CollectionSchemaStatus, CollectionSummary, FieldDefinition,
            FieldValueValidation, MAX_TEXT_BYTES, is_record_id, validate_field_value,
        };

        const RECORDS: usize = 8;
        let service = EngineService::new();
        let field = FieldDefinition::Text {
            name: "notes".into(),
        };
        let limit = dohc_engine_storage::MAX_BLOB_BYTES;
        for (encoded_bytes, blobs) in [(limit, true), (limit + 1, false), (limit + 1, true)] {
            let mut query = CollectionQueryResult {
                collection: CollectionSummary {
                    path: "tasks".into(),
                    status: CollectionSchemaStatus::Valid,
                    reasons: Vec::new(),
                },
                records: (0..RECORDS)
                    .map(|index| CollectionRecord {
                        id: format!("rec_{}{}", "a".repeat(25), char::from(b'a' + index as u8)),
                        path: format!("tasks/{index}.md"),
                        conflicted: false,
                        values: vec![CollectionIndexedValue {
                            field: "notes".into(),
                            value: Value::String(String::new()),
                            validation: CollectionIndexedValueValidation::Valid,
                            resolved_relations: Vec::new(),
                        }],
                    })
                    .collect(),
                groups: None,
                next_cursor: None,
            };
            assert!(query.records.len() <= MAX_COLLECTION_QUERY_LIMIT);
            let overhead = serde_json::to_vec(&query)
                .expect("typed query skeleton")
                .len();
            let text_bytes = encoded_bytes - overhead;
            for (index, record) in query.records.iter_mut().enumerate() {
                assert!(is_record_id(&record.id));
                let length = text_bytes / RECORDS + usize::from(index < text_bytes % RECORDS);
                let text = "x".repeat(length);
                let markdown = format!("---\nid: {}\nnotes: {text}\n---\n", record.id);
                assert!(
                    markdown.len() < MAX_TEXT_BYTES,
                    "each record fits the text cap"
                );
                assert_eq!(
                    validate_field_value(&field, &CollectionFieldValue::Text(text.clone())),
                    FieldValueValidation::Valid,
                );
                record.values[0].value = Value::String(text);
            }
            let response = collection_query_response_value(query).expect("collection projection");
            assert_eq!(
                serde_json::to_vec(&response)
                    .expect("serialized query")
                    .len(),
                encoded_bytes,
            );
            let ctx = if blobs {
                RequestContext::unbounded().with_capability("blobs")
            } else {
                RequestContext::unbounded()
            };
            let cancellation = OperationCancellation::new(&ctx);
            let output = service
                .collection_response_with_blob(
                    &ctx,
                    &cancellation,
                    17,
                    "collections.query",
                    response,
                )
                .await;
            if encoded_bytes > limit {
                let refusal = output.expect_err("oversized collection must be refused");
                assert_eq!(refusal.code, ErrorCode::LimitExceeded, "blobs={blobs}");
                assert_eq!(refusal.message, "collection-response-exceeds-wire-limit");
                continue;
            }
            let (metadata, egress) = output.expect("exact blob limit remains valid");
            let egress = egress.expect("large collection uses blob egress");
            assert_eq!(egress.stream_id, 17);
            assert_eq!(egress.bytes.len(), limit);
            assert!(egress.byte_permit.is_some());
            assert_eq!(metadata["collectionJson"], Value::Null);
            assert_eq!(metadata["byteLength"], json!(limit));
            assert_eq!(metadata["blobSha256"], json!(egress.sha256));
            assert_eq!(
                egress.sha256,
                dohc_engine_storage::hex_sha256(&egress.bytes)
            );
            let decoded: CollectionQueryResult =
                serde_json::from_slice(&egress.bytes).expect("typed collection egress");
            assert_eq!(decoded.records.len(), RECORDS);
            for (index, record) in decoded.records.iter().enumerate() {
                let text = record.values[0].value.as_str().expect("text field");
                assert_eq!(
                    text.len(),
                    text_bytes / RECORDS + usize::from(index < text_bytes % RECORDS),
                );
                assert!(text.bytes().all(|byte| byte == b'x'));
            }
        }
    }

    #[test]
    fn collection_number_marker_shaped_user_objects_use_depth_neutral_key_escaping() {
        for (literal, expected) in [
            (
                json!({ "$dohcInt64": "9007199254740993" }),
                json!({ "$$dohcInt64": "9007199254740993" }),
            ),
            (
                json!({ "$dohcFloat64": "100000000000000000000" }),
                json!({ "$$dohcFloat64": "100000000000000000000" }),
            ),
            (
                json!({ "$$dohcInt64": "literal" }),
                json!({ "$$$dohcInt64": "literal" }),
            ),
        ] {
            let mut encoded = literal.clone();
            encode_collection_wire_numbers(&mut encoded);
            assert_eq!(encoded, expected);

            decode_collection_wire_numbers(&mut encoded).expect("decode escaped collection object");
            assert_eq!(encoded, literal);
        }

        let nested_literal = json!({
            "$dohcInt64": { "$dohcFloat64": "literal" }
        });
        let mut nested_integer = nested_literal.clone();
        encode_collection_wire_numbers(&mut nested_integer);
        assert_eq!(
            nested_integer,
            json!({
                "$$dohcInt64": { "$$dohcFloat64": "literal" }
            })
        );
        decode_collection_wire_numbers(&mut nested_integer)
            .expect("decode nested marker-shaped literals");
        assert_eq!(nested_integer, nested_literal);

        let mut former_escape_marker = json!({
            "$dohcEscaped": { "integer": 9_007_199_254_740_993_i64 }
        });
        encode_collection_wire_numbers(&mut former_escape_marker);
        assert_eq!(
            former_escape_marker,
            json!({ "$dohcEscaped": { "integer": { "$dohcInt64": "9007199254740993" } } })
        );
    }

    #[test]
    fn collection_big_number_markers_preserve_integer_and_float_kinds() {
        for integer in [json!(i64::MIN), json!(u64::MAX)] {
            let mut encoded = integer.clone();
            encode_collection_wire_numbers(&mut encoded);
            let decimal = integer.as_number().expect("integer").to_string();
            assert_eq!(encoded, json!({ "$dohcInt64": decimal }));

            decode_collection_wire_numbers(&mut encoded).expect("decode domain edge");
            assert_eq!(encoded, integer);
        }

        for decimal in ["-9223372036854775809", "18446744073709551616"] {
            let mut marker = json!({ "$dohcInt64": decimal });
            let error = decode_collection_wire_numbers(&mut marker)
                .expect_err("reject integer immediately outside the marker domain");
            assert_eq!(error.code, ErrorCode::InvalidParams);
            assert_eq!(error.message, "collection-integer-marker-invalid");
        }

        let mut out_of_domain_float = json!(100_000_000_000_000_000_000_f64);
        encode_collection_wire_numbers(&mut out_of_domain_float);
        assert_eq!(
            out_of_domain_float,
            json!({ "$dohcFloat64": "100000000000000000000" })
        );
        decode_collection_wire_numbers(&mut out_of_domain_float)
            .expect("decode integral f64 outside the integer domain");
        assert_eq!(out_of_domain_float, json!(100_000_000_000_000_000_000_f64));

        for decimal in ["01", "9007199254740991", "100000000000000000001"] {
            let mut marker = json!({ "$dohcFloat64": decimal });
            let error = decode_collection_wire_numbers(&mut marker)
                .expect_err("reject malformed, safe, or noncanonical float marker");
            assert_eq!(error.code, ErrorCode::InvalidParams);
            assert_eq!(error.message, "collection-float-marker-invalid");
        }
    }

    #[test]
    fn collection_cap_matrix_elides_display_and_overdepth_cursor_values() {
        fn nested_value(containers: usize) -> Value {
            let mut value = json!("leaf");
            for _ in 0..containers {
                value = json!([value]);
            }
            value
        }

        let at_limit = nested_value(23);
        let over_limit = nested_value(24);
        let record = |value: Value| {
            json!({
                "id": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                "path": "tasks/record.md",
                "conflicted": false,
                "values": [{
                    "field": "deep",
                    "value": value,
                    "validation": {
                        "status": "flagged",
                        "reason": { "code": "value-depth-exceeded", "path": "" }
                    },
                    "resolvedRelations": []
                }]
            })
        };
        let collection = json!({
            "path": "tasks",
            "status": "degraded",
            "reasons": [{ "code": "invalid-yaml", "path": "" }]
        });
        let cases = [
            (
                "collections.get",
                json!({
                    "path": "tasks",
                    "status": "valid",
                    "reasons": [],
                    "schema": {
                        "name": null,
                        "description": null,
                        "fields": [],
                        "views": []
                    },
                    "recordCount": 1
                }),
                Vec::<&str>::new(),
            ),
            (
                "collections.query",
                json!({
                    "collection": collection,
                    "records": [record(over_limit.clone()), record(at_limit.clone())],
                    "groups": [{
                        "value": over_limit.clone(),
                        "records": [record(over_limit.clone())]
                    }],
                    "nextCursor": {
                        "sortValues": [{ "present": true, "value": over_limit.clone() }],
                        "recordPath": "tasks/record.md",
                        "recordId": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa"
                    }
                }),
                vec![
                    "/records/0/values/0/value",
                    "/groups/0/value",
                    "/groups/0/records/0/values/0/value",
                ],
            ),
            (
                "collections.getRecord",
                json!({
                    "collection": collection,
                    "record": record(over_limit.clone()),
                    "history": [{
                        "historyId": 1,
                        "field": "deep",
                        "previous": { "present": true, "value": over_limit.clone() },
                        "next": { "present": true, "value": over_limit.clone() },
                        "authorOriginId": null,
                        "recordedAtMs": 1
                    }]
                }),
                vec![
                    "/record/values/0/value",
                    "/history/0/previous/value",
                    "/history/0/next/value",
                ],
            ),
            (
                "collections.list",
                json!({ "collections": [collection] }),
                Vec::<&str>::new(),
            ),
            (
                "collections.listPendingAdoptions",
                json!({
                    "adoptions": [{
                        "versionId": "main",
                        "recordId": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "collectionPath": "tasks",
                        "filePath": "tasks/record.md",
                        "objectId": "object"
                    }],
                    "nextCursor": null
                }),
                Vec::<&str>::new(),
            ),
        ];

        for (surface, input, elided_paths) in cases {
            let response = if surface == "collections.query" {
                collection_query_response_value(
                    serde_json::from_value(input.clone()).expect("typed collection query result"),
                )
            } else {
                collection_response_value(input.clone())
            }
            .unwrap_or_else(|error| panic!("{surface} projection failed: {error:?}"));
            for path in elided_paths {
                assert_eq!(
                    response.pointer(path),
                    Some(&Value::Null),
                    "{surface} {path}"
                );
            }
            if surface == "collections.query" {
                assert_eq!(
                    response.pointer("/records/1/values/0/value"),
                    Some(&at_limit),
                    "the boundary value must remain intact"
                );
                assert_eq!(
                    response.pointer("/nextCursor/sortValues/0/value"),
                    Some(&Value::Null),
                    "an over-depth sort coordinate must not enter the control frame"
                );
                assert_eq!(
                    response.pointer("/nextCursor/sortValues/0/present"),
                    Some(&Value::Bool(false)),
                    "the record tiebreaker is the only usable cursor coordinate"
                );
                assert_eq!(
                    response.pointer("/nextCursor/recordPath"),
                    Some(&json!("tasks/record.md"))
                );
                assert_eq!(
                    response.pointer("/nextCursor/recordId"),
                    Some(&json!("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa"))
                );
            }
            if !input.to_string().contains("value-depth-exceeded") {
                assert_eq!(response, input, "{surface} has no dynamic value to elide");
            }
        }
    }
}
