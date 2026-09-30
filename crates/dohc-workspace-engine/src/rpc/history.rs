use crate::EngineService;
use crate::rpc::capture::MAX_DESKTOP_CAPTURE_TEXT_BYTES;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::reads::inband_text;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use crate::rpc::secrets::secret_moment_json;
use crate::rpc::versions::version_record_json;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_domain::MomentPage;
use dohc_engine_domain::SecretMomentRecord;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;

/// Approximate serialized-bytes budget for one moments.list page: a row
/// can legitimately carry 64 KiB strings (authorJson), so a row COUNT can
/// never bound the frame — the page cuts when the running estimate would
/// pass this, well under the 1 MiB frame limit.
pub(super) const MOMENTS_PAGE_BYTE_BUDGET: usize = 256 * 1024;

const HISTORY_PROTECTED_MOMENT_LIMIT: usize = 500;

const HISTORY_PAGE_FLUSH_RETRIES: usize = 50;

const HISTORY_PAGE_FLUSH_RETRY_DELAY: Duration = Duration::from_millis(20);

struct EncodedMomentPage {
    rows: Vec<Value>,
    included: usize,
    next_before_moment_order: Option<i64>,
    latest_moment_order: i64,
}

impl EncodedMomentPage {
    fn into_json(self) -> Value {
        json!({
            "moments": self.rows[..self.included].to_vec(),
            "nextBeforeMomentOrder": self.next_before_moment_order,
            "latestMomentOrder": self.latest_moment_order,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsListParams {
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    object_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before_moment_order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryPageParams {
    workspace_id: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before_moment_order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsGetParams {
    moment_id: String,
}

pub(super) fn moment_json(moment: &dohc_engine_domain::MomentRecord) -> Value {
    let after_inband_limit = (moment.after_content_kind == "text"
        && moment.after_text.is_none()
        && moment
            .after_byte_length
            .is_some_and(|length| length as usize > MAX_DESKTOP_CAPTURE_TEXT_BYTES))
    .then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
    let before_inband_limit = (moment.before_content_kind == "text"
        && moment.before_text.is_none()
        && moment
            .before_byte_length
            .is_some_and(|length| length as usize > MAX_DESKTOP_CAPTURE_TEXT_BYTES))
    .then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
    json!({
        "momentOrder": moment.moment_order,
        "momentId": moment.moment_id,
        "versionId": moment.version_id,
        "objectId": moment.object_id,
        "path": moment.path,
        "recordedAtMs": moment.recorded_at_ms,
        "operation": moment.operation.as_str(),
        "afterContentKind": moment.after_content_kind,
        "afterBlobSha256": moment.after_blob_sha256,
        "afterBinarySha256": moment.after_binary_sha256,
        "beforePresent": moment.before_present,
        "beforeContentKind": moment.before_content_kind,
        "beforeBlobSha256": moment.before_blob_sha256,
        "beforeBinarySha256": moment.before_binary_sha256,
        "beforeLatestMomentId": moment.before_latest_moment_id,
        "metadataOrigin": moment.metadata_origin,
        "metadataSummary": moment.metadata_summary,
        "metadataCorrelationId": moment.metadata_correlation_id,
        // PARSED authors: absent column = actor-neutral; an entry that does
        // not parse surfaces as an explicit corrupt marker, never silently
        // dropped and never trusted raw.
        "authors": moment.author_json.as_deref().map(parsed_moment_authors),
        "syncRecordOnly": moment.sync_record_only,
        // Hydrated payload text (momentSelectSql parity), each body under
        // the same self-describing in-band cap as every content read.
        "afterText": inband_text(moment.after_text.as_deref()),
        "afterByteLength": moment.after_byte_length,
        "afterInbandLimitBytes": after_inband_limit,
        "beforeText": inband_text(moment.before_text.as_deref()),
        "beforeByteLength": moment.before_byte_length,
        "beforeInbandLimitBytes": before_inband_limit,
        "beforePath": moment.before_path,
    })
}

fn encode_moment_page(page: &MomentPage) -> Result<EncodedMomentPage, WireError> {
    // A row COUNT cannot bound the frame: authorJson alone may be a 64 KiB
    // string. The measured serialized cut is shared by moments.list and the
    // aggregate history page so their text page and cursor stay identical.
    let mut rows: Vec<Value> = page.moments.iter().map(moment_json).collect();
    // A first row may legitimately exceed the page budget. Degrade that row
    // to metadata so the cursor still makes progress, exactly as moments.list
    // did before the history aggregate existed.
    if let Some(first) = rows.first_mut() {
        if serde_json::to_string(first).map_or(0, |s| s.len()) > MOMENTS_PAGE_BYTE_BUDGET {
            first["afterText"] = Value::Null;
            first["beforeText"] = Value::Null;
            first["afterInbandLimitBytes"] = json!(MAX_INBAND_CONTENT_BYTES);
            first["beforeInbandLimitBytes"] = json!(MAX_INBAND_CONTENT_BYTES);
        }
    }
    let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
    if included == 0 && !rows.is_empty() {
        return Err(WireError::new(
            ErrorCode::Internal,
            "a moment row exceeds the response frame budget",
        ));
    }
    let next_before_moment_order = if included < rows.len() {
        page.moments[..included]
            .last()
            .map(|moment| moment.moment_order)
    } else {
        page.next_before_moment_order
    };
    Ok(EncodedMomentPage {
        rows,
        included,
        next_before_moment_order,
        // The TS contract uses -1 for an empty timeline, never null.
        latest_moment_order: page.latest_moment_order.unwrap_or(-1),
    })
}

/// A moment's stored author list, entry by entry. A value that is not a
/// nonempty list reads as one corrupt entry.
fn parsed_moment_authors(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(authors)) if !authors.is_empty() => {
            Value::Array(authors.into_iter().map(parsed_moment_author).collect())
        }
        _ => json!([{ "corrupt": true }]),
    }
}

/// Fail-closed author parsing (parity with the TS wire `MomentAuthorSchema`):
/// only a supported author shape renders as an author. Anything
/// else, such as a hand-edited shape, surfaces as an explicit corrupt
/// marker, never a valid-looking attribution.
fn parsed_moment_author(value: Value) -> Value {
    let corrupt = || json!({ "corrupt": true });
    let Some(object) = value.as_object() else {
        return corrupt();
    };
    let bounded_ids = |keys: &[&str]| {
        keys.iter().all(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty() && v.len() <= 500)
        })
    };
    let principal_ok = object
        .get("onBehalfOf")
        .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()));
    if object.get("kind").and_then(Value::as_str) == Some("public") {
        let valid = object.len() == 3 && bounded_ids(&["principalId", "grantId"]);
        return if valid { value } else { corrupt() };
    }
    // A direct write names its grant and generation, and either the named
    // recipient's user or the link's principal.
    let direct_write_ids = match object.get("kind").and_then(Value::as_str) {
        Some("named") => Some(["userId", "grantId"]),
        Some("link") => Some(["grantId", "principalId"]),
        _ => None,
    };
    if let Some(ids) = direct_write_ids {
        let valid = object.len() == 4
            && bounded_ids(&ids)
            && object
                .get("grantGeneration")
                .and_then(Value::as_i64)
                .is_some_and(|generation| generation >= 1);
        return if valid { value } else { corrupt() };
    }
    if object.get("kind").and_then(Value::as_str) == Some("automation") {
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
        };
        let valid = object.len() == 3 + usize::from(object.contains_key("onBehalfOf"))
            && text("automationId")
            && principal_ok
            && object
                .get("depth")
                .and_then(Value::as_u64)
                .is_some_and(|depth| {
                    depth <= u64::from(dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH)
                });
        return if valid { value } else { corrupt() };
    }
    if object.get("kind").and_then(Value::as_str) == Some("human") {
        let valid = object.len() == 2 + usize::from(object.contains_key("onBehalfOf"))
            && bounded_ids(&["humanId"])
            && principal_ok;
        return if valid { value } else { corrupt() };
    }
    let kind_ok = object.get("kind").and_then(Value::as_str) == Some("agent");
    let nonempty = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    };
    let run_ok = match object.get("agentRunId") {
        None => true,
        Some(Value::String(v)) => !v.is_empty(),
        Some(_) => false,
    };
    if kind_ok && nonempty("agentId") && principal_ok && run_ok {
        let mut author = json!({
            "kind": "agent",
            "agentId": object["agentId"],
        });
        if let Some(principal) = object.get("onBehalfOf") {
            author["onBehalfOf"] = principal.clone();
        }
        // The contract field is OPTIONAL (`agentRunId?: string`), never
        // nullable — omit it when absent, exactly as pickMomentAuthor does.
        if let Some(run_id) = object.get("agentRunId") {
            author["agentRunId"] = run_id.clone();
        }
        // Named only past 0; a depth an older build stored unchecked reads as none.
        if let Some(depth) = dohc_engine_domain::agent_author_depth(object.get("depth")) {
            author["depth"] = json!(depth);
        }
        author
    } else {
        corrupt()
    }
}

/// Withhold both payload bodies of one serialized moment, in place. The
/// digests beside them stay, so the caller hydrates through
/// `versionedText.readBlob` — the shape an over-cap moment already arrives in.
pub(super) fn withhold_moment_texts(moment: &mut Value) {
    for (text, limit) in [
        ("afterText", "afterInbandLimitBytes"),
        ("beforeText", "beforeInbandLimitBytes"),
    ] {
        if moment.get(text).is_some_and(|body| !body.is_null()) {
            moment[text] = Value::Null;
            moment[limit] = json!(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
        }
    }
}

impl EngineService {
    pub(super) async fn moments_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsListParams = parse(params)?;
        // The filter rejects only what the write path can never store
        // (the empty string): every id versionedText.list or
        // moments.list can return — whitespace/control-carrying
        // included — must stay filterable verbatim.
        if params.object_id.as_deref() == Some("") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "objectId must not be empty",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "moments.list",
            open.actor
                .list_moments(dohc_engine_domain::ListMomentsQuery {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    object_id: params.object_id,
                    // Clamped: an unbounded page would load a workspace's whole
                    // history in one actor turn and then fail the wire's
                    // collection cap at encode anyway.
                    // TS normalizeMomentListLimit contract: default 200, cap 500
                    // — page boundaries and cursors must match across engines.
                    limit: params.limit.unwrap_or(200).min(500),
                    before_moment_order: params.before_moment_order,
                }),
        )
        .await?;
        Ok(encode_moment_page(&page)?.into_json())
    }

    pub(super) async fn history_page(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: HistoryPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;

        let mut flush = self
            .capture_flush_once(ctx, &open, "history.page capture flush")
            .await?;
        for _ in 0..HISTORY_PAGE_FLUSH_RETRIES {
            if flush.settled {
                break;
            }
            let cancellation = OperationCancellation::new(ctx);
            tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption("history.page capture flush retry"));
                }
                () = tokio::time::sleep(HISTORY_PAGE_FLUSH_RETRY_DELAY) => {}
            }
            flush = self
                .capture_flush_once(ctx, &open, "history.page capture flush")
                .await?;
        }
        if !flush.settled {
            return Err(WireError::new(
                ErrorCode::Overloaded,
                "History is still updating. Try again.",
            ));
        }

        let cancellation = OperationCancellation::new(ctx);
        let read = Self::read_under_ctx(
            &cancellation,
            "history.page",
            open.actor.history_page(
                open.workspace_id.clone(),
                params.limit.unwrap_or(200).min(500),
                params.before_moment_order,
                HISTORY_PROTECTED_MOMENT_LIMIT + 1,
            ),
        )
        .await?;
        let text_page = encode_moment_page(&read.text_moment_page)?;
        let lower_recorded_at_ms = text_page.next_before_moment_order.and_then(|_| {
            read.text_moment_page
                .moments
                .get(text_page.included.saturating_sub(1))
                .map(|moment| moment.recorded_at_ms)
        });
        let protected_moments: Vec<&SecretMomentRecord> = read
            .protected_moments
            .iter()
            .filter(|moment| {
                lower_recorded_at_ms.is_none_or(|lower| moment.recorded_at_ms > lower)
                    && read
                        .upper_recorded_at_ms
                        .is_none_or(|upper| moment.recorded_at_ms <= upper)
            })
            .collect();
        let row_truncated = protected_moments.len() > HISTORY_PROTECTED_MOMENT_LIMIT;
        let protected_rows: Vec<Value> = protected_moments
            .into_iter()
            .take(HISTORY_PROTECTED_MOMENT_LIMIT)
            .map(secret_moment_json)
            .collect();
        let included = byte_budget_cut_serialized(&protected_rows, MOMENTS_PAGE_BYTE_BUDGET);
        let byte_truncated = included < protected_rows.len();
        Ok(json!({
            "activeVersion": version_record_json(&read.active_version),
            "textMomentPage": text_page.into_json(),
            "protectedMoments": &protected_rows[..included],
            "protectedTruncated": row_truncated || byte_truncated,
        }))
    }

    pub(super) async fn moments_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsGetParams = parse(params)?;
        // Reject only what the write path can never store (the empty
        // string): all-whitespace ids are storable and moments.list
        // returns them verbatim — they must stay fetchable verbatim.
        if params.moment_id.is_empty() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "momentId must not be empty",
            ));
        }
        let moment_id = params.moment_id;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = Self::read_under_ctx(
            &cancellation,
            "moments.get",
            open.actor.get_moment(open.workspace_id.clone(), moment_id),
        )
        .await?;
        Ok(match moment {
            None => Value::Null,
            Some(moment) => moment_json(&moment),
        })
    }
}

#[cfg(test)]
mod relay_author_tests {
    use super::parsed_moment_authors;
    use serde_json::{Value, json};

    /// One stored author, read back as the entry history returns for it.
    fn parsed_moment_author(raw: &str) -> Value {
        let value: Value = serde_json::from_str(raw).expect("test author is JSON");
        let authors = parsed_moment_authors(&json!([value]).to_string());
        let [author] = authors.as_array().expect("a list").as_slice() else {
            panic!("one author in, one author out: {authors}");
        };
        author.clone()
    }

    #[test]
    fn reads_every_author_of_a_moment_and_refuses_a_value_that_is_not_a_list() {
        let agent = json!({"kind":"agent", "agentId":"agent"});
        let human = json!({"kind":"human", "humanId":"ada", "onBehalfOf":"ada"});
        assert_eq!(
            parsed_moment_authors(&json!([agent, human, {"kind":"agent"}]).to_string()),
            json!([agent, human, {"corrupt":true}])
        );
        for stored in [agent.to_string(), "[]".to_owned(), "not json".to_owned()] {
            assert_eq!(
                parsed_moment_authors(&stored),
                json!([{"corrupt":true}]),
                "{stored}"
            );
        }
    }

    #[test]
    fn preserves_a_person_author_and_refuses_incomplete_or_mixed_shapes() {
        for author in [
            json!({"kind":"human", "humanId":"ada"}),
            json!({"kind":"human", "humanId":"ada", "onBehalfOf":"ada"}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
        }
        for malformed in [
            json!({"kind":"human"}),
            json!({"kind":"human", "humanId":""}),
            json!({"kind":"human", "humanId":"ada", "onBehalfOf":""}),
            json!({"kind":"human", "humanId":"ada", "agentId":"agent"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn preserves_declared_authors_without_inventing_a_principal() {
        for author in [
            json!({"kind":"agent", "agentId":"agent"}),
            json!({"kind":"agent", "agentId":"agent", "agentRunId":"run", "depth":3}),
            json!({"kind":"automation", "automationId":"collection:tasks#stamp", "depth":4}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
            for principal in [json!(null), json!(""), json!(42)] {
                let mut malformed = author.clone();
                malformed["onBehalfOf"] = principal;
                assert_eq!(
                    parsed_moment_author(&malformed.to_string()),
                    json!({"corrupt":true})
                );
            }
        }
        for malformed in [
            json!({"kind":"agent"}),
            json!({"kind":"automation", "automationId":"collection:tasks#stamp"}),
            json!({"kind":"automation", "depth":4}),
            json!({"kind":"automation", "automationId":"a", "depth":65}),
            json!({"kind":"automation", "automationId":"a", "depth":4, "extra":true}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    /// An older build stored an agent author with any depth it was given, 0
    /// included. After an upgrade, history reads such a depth as none, as it
    /// reads a run a person started.
    #[test]
    fn reads_a_stored_agent_depth_outside_the_chain_as_none() {
        let named =
            json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"local", "agentRunId":"run"});
        for depth in [json!(0), json!(65), json!("3"), json!(null)] {
            let mut stored = named.clone();
            stored["depth"] = depth;
            assert_eq!(parsed_moment_author(&stored.to_string()), named, "{stored}");
        }
    }

    #[test]
    fn preserves_public_author_and_refuses_incomplete_or_mixed_shapes() {
        let author = json!({"kind":"public", "principalId":"holder", "grantId":"grant"});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        let automation = json!({
            "kind": "automation",
            "automationId": "collection:tasks#stamp",
            "onBehalfOf": "local",
            "depth": 1,
        });
        assert_eq!(parsed_moment_author(&automation.to_string()), automation);
        assert_eq!(
            parsed_moment_author(
                &json!({"kind":"automation", "automationId":"a", "onBehalfOf":"local"}).to_string()
            ),
            json!({"corrupt":true}),
            "an automation author names its depth"
        );
        for malformed in [
            json!({"kind":"public", "principalId":"holder"}),
            json!({"kind":"public", "principalId":"", "grantId":"grant"}),
            json!({"kind":"public", "principalId":"holder", "grantId":"grant", "agentId":"agent"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn preserves_named_author_and_refuses_incomplete_or_mixed_shapes() {
        let author =
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":2});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        for malformed in [
            json!({"kind":"named", "userId":"ana", "grantId":"grant"}),
            json!({"kind":"named", "userId":"", "grantId":"grant", "grantGeneration":2}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":0}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":"2"}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":2, "email":"ana@example.com"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn preserves_link_author_and_refuses_incomplete_or_mixed_shapes() {
        let author =
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder"});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        for malformed in [
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":""}),
            json!({"kind":"link", "grantId":"", "grantGeneration":2, "principalId":"holder"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":0, "principalId":"holder"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":"2", "principalId":"holder"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"p".repeat(501)}),
            // A claimed name never rides a link author, and neither does a user.
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder", "displayName":"Ana"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder", "userId":"ana"}),
            json!({"kind":"link", "userId":"ana", "grantId":"grant", "grantGeneration":2}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true}),
                "{malformed}"
            );
        }
    }
}
