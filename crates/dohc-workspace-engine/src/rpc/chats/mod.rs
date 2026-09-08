pub(super) mod bookmarks;
pub(super) mod channels;
pub(super) mod dispatch;
pub(super) mod feed;
pub(super) mod follows;
pub(super) mod messages;
pub(super) mod read_state;
pub(super) mod threads;

use crate::rpc::error::wire;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::deserialize_optional_non_null_string;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// Approximate serialized-bytes budget for one chat list/messages page —
/// the same measured discipline as every other list family.
const CHAT_PAGE_BYTE_BUDGET: usize = 256 * 1024;

const CHAT_PAGE_LIMIT_DEFAULT: i64 = 200;

const CHAT_PAGE_LIMIT_MAX: i64 = 500;

/// Versioned, opaque continuation state for the RPC-B2 chat families. The
/// binding is a digest over method + authenticated workspace + logical
/// filters, so a cursor cannot be replayed against another view.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatKeysetCursor {
    pub(super) version: u8,
    pub(super) binding: String,
    pub(super) consumed: i64,
    pub(super) first: i64,
    pub(super) second: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) third: Option<String>,
}

pub(super) fn chat_cursor_binding(method: &str, workspace_id: &str, filters: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for field in std::iter::once(method)
        .chain(std::iter::once(workspace_id))
        .chain(filters.iter().copied())
    {
        hasher.update(field.as_bytes());
        hasher.update([0]);
    }
    dohc_engine_storage::hex(&hasher.finalize())
}

pub(super) fn encode_chat_cursor(cursor: &ChatKeysetCursor) -> Result<String, WireError> {
    let bytes =
        serde_json::to_vec(cursor).map_err(|_| wire(ErrorCode::Internal, "state-corrupt"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) fn decode_chat_cursor(
    encoded: Option<&str>,
    expected_binding: &str,
) -> Result<Option<ChatKeysetCursor>, WireError> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let invalid = || wire(ErrorCode::InvalidParams, "invalid-cursor");
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let cursor: ChatKeysetCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.version != 1
        || cursor.binding != expected_binding
        || cursor.consumed < 0
        || cursor.second.is_empty()
    {
        return Err(invalid());
    }
    Ok(Some(cursor))
}

pub(super) fn chat_page_limit(value: Option<i64>) -> Result<i64, WireError> {
    let value = value.unwrap_or(CHAT_PAGE_LIMIT_DEFAULT);
    if !(1..=CHAT_PAGE_LIMIT_MAX).contains(&value) {
        return Err(wire(ErrorCode::InvalidParams, "invalid-parameters"));
    }
    Ok(value)
}

pub(super) fn bounded_chat_page_len(rows: &[Value]) -> Result<usize, WireError> {
    let included = byte_budget_cut_serialized(rows, CHAT_PAGE_BYTE_BUDGET);
    if included == 0 && !rows.is_empty() {
        return Err(wire(ErrorCode::LimitExceeded, "row-exceeds-wire-limit"));
    }
    Ok(included)
}

pub(super) fn chat_page_cursor<T>(
    rows: &[T],
    included: usize,
    consumed: i64,
    binding: String,
    coordinate: impl FnOnce(&T) -> (i64, String),
) -> Result<Option<String>, WireError> {
    if rows.len() <= included {
        return Ok(None);
    }
    let last = rows
        .get(included.saturating_sub(1))
        .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
    let (first, second) = coordinate(last);
    encode_chat_cursor(&ChatKeysetCursor {
        version: 1,
        binding,
        consumed: consumed + included as i64,
        first,
        second,
        third: None,
    })
    .map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatPageParams {
    pub(super) page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    pub(super) cursor: Option<String>,
}
