//! [`LinkedChatStore`]: the chats domain over the R04 storage core (R09).
//!
//! The chat surface — channels, threads, messages, per-thread read state,
//! receiver-private follows / personal feed / bookmarks, and the durable agent
//! dispatch ledger — composed ON the storage seam exactly like the versioning
//! domain: reads via [`EngineStore::read_with`], every compound mutation via
//! [`EngineStore::write_with`] so the domain write and its replication-journal
//! entry commit in ONE `BEGIN IMMEDIATE` transaction (PORTING.md §9). Storage
//! owns the connection, open ritual, transaction boundary, and the crash
//! fault seam; this crate owns what a channel / thread / message / read-cursor /
//! follow / bookmark / dispatch claim *means* (the TS `linkedChatStore.ts` +
//! `agentDispatchStore.ts` oracle behavior).
//!
//! Content identity is caller-supplied: `channel_id`, `thread_id`,
//! `message_id`, and `run_id` are inputs — the same determinism the
//! versioning domain uses (`object_id`/`moment_id` are inputs). This keeps the
//! differential harness able to pin exact rows. Local replication origins are
//! store-owned and initialized lazily, while bookmark ids are deterministically
//! derived from their owner and target, matching the TS store.
//!
//! **Parity-critical, non-tautological surfaces** (validated against real TS
//! output, not Rust's own):
//! - [`channel_slug_for_name`] — NFC + lowercase + dash-collapse slug (matrix
//!   4.1b). A rename never forks channel state (durable rows key on
//!   `channel_id`; the slug is a lookup alias).
//! - [`linked_chat_projection_path`] — NFC projection fields feed a
//!   `sha256` + base32-lowercase digest into `.dohc/chats/v1-<b32>.md` (matrix
//!   4.1b). An NFD input yields the byte-identical path as the NFC input.
//! - [`encode_feed_cursor`] / [`decode_feed_cursor`] — unpadded base64url of a
//!   JSON `[createdAtMs, messageId]` body (matrix 4.8). A TS-minted cursor
//!   round-trips; any decode/shape failure fails closed as `invalid-follow-target`.
//!
//! **Scoped to R10 (sync) or later, with notes in the crate docs**: the
//! replication-op apply arms (`chat.*` receiver-private LWW application),
//! reactions/decisions/attachment/mention indexing detail, and the desktop-side
//! bookmark projection materialization. R09 ships the LOCAL write/read/list
//! primitives, the atomic-send + read-CAS models, the generation-CAS bookmark
//! outbox, and the single-writer dispatch ledger.

use crate::error::DomainError;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;

// ------------------------------------------------------------------- constants

/// The auto-created default channel's display name.
pub const GENERAL_CHANNEL_NAME: &str = "general";
/// Deterministic cross-machine wire id for the auto-created `general` channel,
/// so independently minted rows converge as ONE channel under sync.
pub const GENERAL_CHANNEL_WIRE_ID: &str = "channel_wire_general_v1";
/// The reserved agent channel's display name.
pub const AGENT_CHANNEL_NAME: &str = "My agent";
/// Deterministic cross-machine wire id for the reserved `My agent` channel.
pub const AGENT_CHANNEL_WIRE_ID: &str = "channel_wire_agent_v1";
/// The default linked-chat projection kind (`linkedChatStore.ts:90`).
pub const LINKED_CHAT_PROJECTION_KIND: &str = "thread";

/// Message body byte cap (64 KiB UTF-8, `normalizeBody`).
pub const MAX_MESSAGE_BODY_BYTES: usize = 64 * 1024;
/// Thread title char cap (`normalizeThreadTitle`).
const MAX_THREAD_TITLE_CHARS: usize = 200;
/// Channel name char cap (`normalizeChannelName`).
const MAX_CHANNEL_NAME_CHARS: usize = 80;
/// Display-name char cap (`normalizeDisplayName`).
const MAX_DISPLAY_NAME_CHARS: usize = 200;
/// Opaque relay user-id char cap (`normalizeAuthorUserId`).
const MAX_AUTHOR_USER_ID_CHARS: usize = 200;
/// Feed cursor string cap (`decodeFeedCursor`).
const MAX_FEED_CURSOR_LEN: usize = 512;
/// Feed cursor message-id char cap (`decodeFeedCursor`).
const MAX_FEED_CURSOR_MESSAGE_ID_CHARS: usize = 256;
/// Maximum UTF-8 bytes available to a message id in a worst-case feed cursor.
/// A 512-byte unpadded-base64url value decodes to at most 384 bytes. The JSON
/// `[i64::MIN,"id"]` framing costs exactly 25 bytes (20 timestamp bytes plus
/// `[`, `,"`, and `"]`), leaving 359 bytes for the unescaped id.
const MAX_FEED_CURSOR_MESSAGE_ID_BYTES: usize = (MAX_FEED_CURSOR_LEN / 4) * 3 - 25;
/// Required dispatch ids are trimmed before storage and bounded like the TS
/// store's JavaScript strings (UTF-16 code units).
const MAX_DISPATCH_ID_UTF16_UNITS: usize = 512;
/// Replicated chat identifiers use the sync payload validator's UTF-16 and
/// UTF-8 bounds.
const MAX_REPLICATED_CHAT_ID_UTF16_UNITS: usize = 256;
const MAX_REPLICATED_CHAT_ID_UTF8_BYTES: usize = 512;
/// Dispatch metadata uses the TS store's 16,384 UTF-16-code-unit text bound.
const MAX_DISPATCH_METADATA_UTF16_UNITS: usize = 16_384;
/// Sentinel message id for the synthetic per-thread header FTS row.
pub const CHAT_THREAD_HEADER_MESSAGE_ID: &str = "__thread__";
/// Untitled-thread snippet cap (`THREAD_SNIPPET_TITLE_MAX_CHARS`).
pub const THREAD_SNIPPET_TITLE_MAX_CHARS: usize = 80;
/// Untitled-thread fallback (`UNTITLED_THREAD_FALLBACK_TITLE`).
const UNTITLED_THREAD_FALLBACK_TITLE: &str = "New chat";
/// Feed page limit bounds (`listPersonalFeed`).
const FEED_LIMIT_MAX: i64 = 100;
const FEED_LIMIT_DEFAULT: i64 = 20;
/// Hard upper bound on a single [`LinkedChatStore::list_messages`] page. A caller
/// asking for more is clamped to this; the returned `next_after_message_order`
/// cursor pages the rest. Keeps every read bounded (plan §Rust policy).
pub const MAX_MESSAGE_PAGE: i64 = 500;
/// Hard cap on the low-cardinality workspace lists (channels/threads/follows/
/// bookmarks). These are per-workspace enumerations with no natural paging in the
/// TS oracle; the cap bounds the returned `Vec` so a corrupt/huge store cannot
/// materialize an unbounded allocation. Chosen well above realistic cardinality.
const MAX_LIST_ROWS: i64 = 10_000;
/// base32 lowercase (RFC 4648, no padding) alphabet (`linkedChatStore.ts:557`).
const BASE32_LOWERCASE_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

// --------------------------------------------------------------------- records

/// A chat channel kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatChannelKind {
    Channel,
    Dm,
    Agent,
}

impl ChatChannelKind {
    fn as_str(self) -> &'static str {
        match self {
            ChatChannelKind::Channel => "channel",
            ChatChannelKind::Dm => "dm",
            ChatChannelKind::Agent => "agent",
        }
    }
    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "channel" => Ok(ChatChannelKind::Channel),
            "dm" => Ok(ChatChannelKind::Dm),
            "agent" => Ok(ChatChannelKind::Agent),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat channel has an unknown kind",
            }),
        }
    }
}

/// A chat message author kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatActorKind {
    Human,
    Agent,
}

impl ChatActorKind {
    fn as_str(self) -> &'static str {
        match self {
            ChatActorKind::Human => "human",
            ChatActorKind::Agent => "agent",
        }
    }
    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "human" => Ok(ChatActorKind::Human),
            "agent" => Ok(ChatActorKind::Agent),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat message has an unknown author kind",
            }),
        }
    }
}

/// A durable chat channel row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatChannel {
    pub workspace_id: String,
    pub channel_id: String,
    pub name: String,
    pub slug: String,
    pub kind: ChatChannelKind,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// A channel row plus derived thread/unread aggregates for channel listings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatChannelSummary {
    pub channel: ChatChannel,
    pub thread_count: i64,
    pub unread_count: i64,
}

/// A durable chat thread row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatThread {
    pub workspace_id: String,
    pub thread_id: String,
    pub title: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub channel_id: Option<String>,
    pub linked_object_id: Option<String>,
}

/// A durable chat message row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub workspace_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub message_order: i64,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub author_user_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub origin: Option<String>,
    pub body: String,
    pub created_at_ms: i64,
}

/// The per-thread read cursor (server-owned monotonic register + CAS revision).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatThreadReadState {
    pub workspace_id: String,
    pub thread_id: String,
    pub last_read_sequence: i64,
    pub revision: i64,
    pub updated_at_ms: i64,
}

/// A follow target kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowTargetKind {
    Person,
    Agent,
    Channel,
    Thread,
}

impl FollowTargetKind {
    fn as_str(self) -> &'static str {
        match self {
            FollowTargetKind::Person => "person",
            FollowTargetKind::Agent => "agent",
            FollowTargetKind::Channel => "channel",
            FollowTargetKind::Thread => "thread",
        }
    }
    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "person" => Ok(FollowTargetKind::Person),
            "agent" => Ok(FollowTargetKind::Agent),
            "channel" => Ok(FollowTargetKind::Channel),
            "thread" => Ok(FollowTargetKind::Thread),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat follow has an unknown target kind",
            }),
        }
    }
}

/// A follow LWW state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowState {
    Following,
    Unfollowed,
}

impl FollowState {
    fn as_str(self) -> &'static str {
        match self {
            FollowState::Following => "following",
            FollowState::Unfollowed => "unfollowed",
        }
    }
    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "following" => Ok(FollowState::Following),
            "unfollowed" => Ok(FollowState::Unfollowed),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat follow has an unknown state",
            }),
        }
    }
}

/// A durable follow row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFollow {
    pub owner_user_id: String,
    pub target_kind: FollowTargetKind,
    pub target_id: String,
    pub state: FollowState,
    pub updated_at_ms: i64,
    pub origin_id: String,
    pub origin_seq: i64,
}

/// A decoded personal-feed cursor coordinate (`FeedCursorValue`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedCursorValue {
    pub created_at_ms: i64,
    pub message_id: String,
}

/// One fully hydrated personal-feed item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFeedItem {
    pub message: ChatMessage,
    pub thread: ChatThread,
    pub channel: Option<ChatChannel>,
    pub parent_message: Option<ChatMessage>,
    pub opening_message: Option<ChatMessage>,
    /// Reactions are an RPC-B2 domain; keep the required feed field empty until
    /// that domain is ported rather than returning the old coordinate-only shape.
    pub reactions: Vec<ChatReaction>,
    pub matched_by: Vec<FollowTargetKind>,
}

/// Placeholder for the unported RPC-B2 reaction domain. Feed hydration always
/// returns an empty vector today, but the typed field prevents shape regression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReaction;

#[derive(Debug, Clone, PartialEq, Eq)]
struct FeedCandidate {
    message_id: String,
    thread_id: String,
    created_at_ms: i64,
}

/// The personal feed's receiver-private, monotonic read cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFeedReadState {
    pub workspace_id: String,
    pub owner_user_id: String,
    pub last_seen_created_at_ms: i64,
    pub last_seen_message_id: String,
    pub updated_at_ms: i64,
}

/// A page of personal-feed items, newest first, with a base64url keyset cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFeedPage {
    pub items: Vec<ChatFeedItem>,
    pub next_cursor: Option<String>,
    pub head_cursor: Option<String>,
    pub read_state: Option<ChatFeedReadState>,
}

/// A bookmark target kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookmarkTargetKind {
    Message,
    Thread,
}

impl BookmarkTargetKind {
    fn as_str(self) -> &'static str {
        match self {
            BookmarkTargetKind::Message => "message",
            BookmarkTargetKind::Thread => "thread",
        }
    }
}

/// A bookmark projection mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookmarkMode {
    Live,
    Snapshot,
}

impl BookmarkMode {
    fn as_str(self) -> &'static str {
        match self {
            BookmarkMode::Live => "live",
            BookmarkMode::Snapshot => "snapshot",
        }
    }
}

/// A durable bookmark row plus its outbox projection state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatBookmark {
    pub bookmark_id: String,
    pub owner_user_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub thread_id: String,
    pub message_id: Option<String>,
    pub mode: String,
    pub destination_path: String,
    pub state: String,
    pub generation: i64,
    pub projected_generation: i64,
    pub projection_state: String,
    pub projection_object_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_projected_at_ms: Option<i64>,
    pub failure_reason: Option<String>,
}

/// The outcome of a bookmark projection transition (generation-CAS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatBookmarkTransition {
    pub bookmark: ChatBookmark,
    pub applied: bool,
}

/// A durable dispatch claim (ledger row + minted run record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchClaim {
    pub dispatch: DispatchRecord,
    pub run: AgentRunRecord,
}

/// A durable dispatch-ledger row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRecord {
    pub workspace_id: String,
    pub trigger_message_id: String,
    pub thread_id: String,
    pub state: String,
    pub run_id: Option<String>,
    pub failure_reason: Option<String>,
    pub attempt_count: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// A durable agent-run row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunRecord {
    pub workspace_id: String,
    pub run_id: String,
    pub thread_id: String,
    pub trigger_message_id: String,
    pub command: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i64>,
    pub failure_reason: Option<String>,
    pub log_path: Option<String>,
    pub failure_note_posted: bool,
}

// ---------------------------------------------------------------------- inputs

/// Inputs to [`LinkedChatStore::start_channel_thread`].
#[derive(Debug, Clone)]
pub struct StartChannelThread {
    pub workspace_id: String,
    pub channel_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub title: Option<String>,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub author_user_id: Option<String>,
    pub origin: Option<String>,
    pub body: String,
    pub now_ms: i64,
    /// Optional idempotency key. When set, an after-commit-before-ack retry with
    /// the same key + payload replays the recorded result exactly-once instead of
    /// hitting the message PK and failing a write that actually succeeded.
    pub request_id: Option<String>,
}

/// Inputs to [`LinkedChatStore::send_message`].
#[derive(Debug, Clone)]
pub struct SendMessage {
    pub workspace_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub author_user_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub origin: Option<String>,
    pub body: String,
    pub now_ms: i64,
    /// Optional idempotency key (see [`StartChannelThread::request_id`]).
    pub request_id: Option<String>,
}

/// Inputs to [`LinkedChatStore::set_follow`].
#[derive(Debug, Clone)]
pub struct SetFollow {
    pub workspace_id: String,
    pub owner_user_id: String,
    pub replication_owner_user_id: Option<String>,
    pub target_kind: FollowTargetKind,
    pub target_id: String,
    pub state: FollowState,
    pub now_ms: i64,
}

/// Inputs to [`LinkedChatStore::save_bookmark`].
#[derive(Debug, Clone)]
pub struct SaveBookmark {
    pub workspace_id: String,
    pub owner_user_id: String,
    pub target_kind: BookmarkTargetKind,
    pub target_id: String,
    pub mode: BookmarkMode,
    pub destination_path: String,
    pub now_ms: i64,
}

/// A page of chat messages, oldest first, with a keyset probe cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessagePage {
    pub messages: Vec<ChatMessage>,
    pub next_after_message_order: Option<i64>,
}

// --------------------------------------------------------------- parity helpers

/// NFC-normalize a string (matrix 4.1b identity normalization).
fn nfc(value: &str) -> String {
    value.nfc().collect()
}

/// The channel lookup slug derived from a display name — NFC, lowercase,
/// dash-separated, ascii-safe (`channelSlugForName`, matrix 4.1b). Durable rows
/// key on `channel_id`, never the slug, so a rename cannot fork channel state.
///
/// Ports the TS transform verbatim: `NFC` → `toLowerCase` → collapse
/// whitespace/underscore runs to `-` → drop everything outside `[a-z0-9-]` →
/// collapse `-` runs → trim leading/trailing `-`.
pub fn channel_slug_for_name(name: &str) -> String {
    let lowered = nfc(name).to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    // Whitespace and `_` become `-`; other non-`[a-z0-9-]` chars are dropped.
    for ch in lowered.chars() {
        if ch.is_whitespace() || ch == '_' {
            out.push('-');
        } else if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
            out.push(ch);
        }
        // else: dropped (matches `.replace(/[^a-z0-9-]/gu, "")`).
    }
    // Collapse `-` runs and trim leading/trailing `-`.
    let mut collapsed = String::with_capacity(out.len());
    let mut prev_dash = false;
    for ch in out.chars() {
        if ch == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(ch);
            prev_dash = false;
        }
    }
    collapsed.trim_matches('-').to_owned()
}

/// base32 lowercase (RFC 4648, no padding) of `bytes` (`base32LowercaseNoPadding`).
pub fn base32_lowercase_no_padding(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(8).div_ceil(5));
    let mut value: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits = bits.saturating_add(8);
        while bits >= 5 {
            let idx = ((value >> (bits - 5)) & 31) as usize;
            out.push(BASE32_LOWERCASE_ALPHABET[idx] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        let idx = ((value << (5 - bits)) & 31) as usize;
        out.push(BASE32_LOWERCASE_ALPHABET[idx] as char);
    }
    out
}

/// Stable bookmark identity: `bookmark_` plus lowercase unpadded base32 of the
/// first 16 SHA-256 bytes of `owner\0target-kind\0target-id`.
pub fn bookmark_id_for(
    owner_user_id: &str,
    target_kind: BookmarkTargetKind,
    target_id: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(owner_user_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(target_kind.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(target_id.as_bytes());
    let digest = hasher.finalize();
    format!("bookmark_{}", base32_lowercase_no_padding(&digest[..16]))
}

/// A projection field must be non-empty, not `.`/`..`, contain no `/`, `\`, or
/// control chars (`normalizeProjectionField`); returns the NFC form.
fn normalize_projection_field(field: &str, value: &str) -> Result<String, DomainError> {
    let normalized = nfc(value);
    if normalized.is_empty()
        || normalized == "."
        || normalized == ".."
        || normalized.contains('/')
        || normalized.contains('\\')
        || has_projection_control_char(&normalized)
    {
        return Err(DomainError::chat(
            "invalid-path",
            match field {
                "workspaceId" => "workspaceId is invalid for a linked chat projection path",
                "threadId" => "threadId is invalid for a linked chat projection path",
                _ => "projectionKind is invalid for a linked chat projection path",
            },
        ));
    }
    Ok(normalized)
}

/// The control-char class shared by the projection/heading/channel validators
/// (`PROJECTION_FIELD_CONTROL_CHAR = /[\x00-\x1f\x7f]/u`).
fn has_projection_control_char(value: &str) -> bool {
    value
        .chars()
        .any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f)
}

/// The content-addressed read-only projection path for a linked chat thread:
/// `.dohc/chats/v1-<base32(sha256("v1\0ws\0thread\0kind"))>.md`
/// (`linkedChatProjectionPath`, matrix 4.1b). NFC-normalizes each field so an
/// NFD input yields the byte-identical path.
pub fn linked_chat_projection_path(
    workspace_id: &str,
    thread_id: &str,
    projection_kind: Option<&str>,
) -> Result<String, DomainError> {
    let workspace_id = normalize_projection_field("workspaceId", workspace_id)?;
    let thread_id = normalize_projection_field("threadId", thread_id)?;
    let projection_kind = normalize_projection_field(
        "projectionKind",
        projection_kind.unwrap_or(LINKED_CHAT_PROJECTION_KIND),
    )?;
    let mut hasher = Sha256::new();
    hasher.update(b"v1\0");
    hasher.update(workspace_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(thread_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(projection_kind.as_bytes());
    let digest = hasher.finalize();
    Ok(format!(
        ".dohc/chats/v1-{}.md",
        base32_lowercase_no_padding(&digest)
    ))
}

/// Encode a personal-feed cursor: unpadded base64url of the JSON body
/// `[createdAtMs, messageId]` (`encodeFeedCursor`, matrix 4.8). Byte-parity with
/// the TS `Buffer.from(JSON.stringify([...]), "utf8").toString("base64url")`.
pub fn encode_feed_cursor(value: &FeedCursorValue) -> String {
    // serde_json serializes an i64 as an integer literal and a tuple as a JSON
    // array with no interior spaces, matching `JSON.stringify([n, "id"])`.
    let body = serde_json::to_string(&(value.created_at_ms, &value.message_id))
        .unwrap_or_else(|_| String::from("[]"));
    URL_SAFE_NO_PAD.encode(body.as_bytes())
}

/// Decode a personal-feed cursor, failing closed as `invalid-follow-target` on
/// ANY decode/shape violation (`decodeFeedCursor`, matrix 4.8). Accepts exactly
/// the strings the TS engine emits (unpadded url-safe base64 of the JSON body).
///
/// DELIBERATE DIVERGENCE (Rust is stricter, fail-closed, on NON-engine-minted
/// cursors — recorded in BEHAVIOR_DELTA §10): (1) `createdAtMs` must be an
/// integral i64 here, whereas TS accepts any finite JS number (our feed only
/// ever EMITS integral coordinates, so a fractional/out-of-range value is never
/// a cursor this engine minted); (2) the message-id length cap counts Unicode
/// scalar values (`chars().count()`) rather than JS UTF-16 units, so an astral
/// string near the 256 boundary can be rejected on one engine and accepted on
/// the other. Engine-MINTED cursors round-trip byte-exact on both sides (pinned
/// by the differential); the divergence only tightens acceptance of adversarial
/// client input, which is the safe direction. R10/differential must treat this
/// as intended, not a bug.
pub fn decode_feed_cursor(cursor: &str) -> Result<FeedCursorValue, DomainError> {
    let invalid = || DomainError::chat("invalid-follow-target", "Feed cursor is invalid.");
    if cursor.is_empty() || cursor.len() > MAX_FEED_CURSOR_LEN {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .map_err(|_| invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    let arr = parsed.as_array().ok_or_else(invalid)?;
    if arr.len() != 2 {
        return Err(invalid());
    }
    // TS keeps createdAtMs as a finite JS number; our feed only ever emits
    // integral coordinates, so a non-integral / out-of-i64-range number is not a
    // cursor this engine minted — fail closed.
    let created_at_ms = arr
        .first()
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(invalid)?;
    let message_id = arr
        .get(1)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if message_id.is_empty() || message_id.chars().count() > MAX_FEED_CURSOR_MESSAGE_ID_CHARS {
        return Err(invalid());
    }
    Ok(FeedCursorValue {
        created_at_ms,
        message_id: message_id.to_owned(),
    })
}

// --------------------------------------------------------------- normalization

fn non_empty(value: &str, code: &'static str, reason: &'static str) -> Result<(), DomainError> {
    if value.is_empty() {
        Err(DomainError::chat(code, reason))
    } else {
        Ok(())
    }
}

/// Message ids can become the second coordinate in an encoded personal-feed
/// cursor. Keep caller-supplied ids within the exact cap enforced by
/// [`decode_feed_cursor`], in addition to the empty/ASCII-control floor, so an
/// emitted page cursor is always accepted by the next page request.
fn validate_message_id(message_id: &str) -> Result<(), DomainError> {
    if message_id.is_empty()
        || has_projection_control_char(message_id)
        || message_id.chars().count() > MAX_FEED_CURSOR_MESSAGE_ID_CHARS
        || message_id.len() > MAX_FEED_CURSOR_MESSAGE_ID_BYTES
        || encode_feed_cursor(&FeedCursorValue {
            created_at_ms: i64::MIN,
            message_id: message_id.to_owned(),
        })
        .len()
            > MAX_FEED_CURSOR_LEN
    {
        Err(DomainError::InvalidInput {
            reason: "message id is invalid",
        })
    } else {
        Ok(())
    }
}

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

/// Caller-minted local ids are normalized before they become replicated ids,
/// then checked with `isBoundedReplicatedId`'s exact trim/control/UTF-16 rules.
fn normalize_replicated_chat_id(value: &str, reason: &'static str) -> Result<String, DomainError> {
    let normalized = value.trim_matches(is_js_trim_ws);
    if normalized.is_empty()
        || normalized.encode_utf16().count() > MAX_REPLICATED_CHAT_ID_UTF16_UNITS
        || normalized.len() > MAX_REPLICATED_CHAT_ID_UTF8_BYTES
        || has_projection_control_char(normalized)
    {
        Err(DomainError::InvalidInput { reason })
    } else {
        Ok(normalized.to_owned())
    }
}

/// Claim metadata follows `normalizeCommand`: an omitted command is the EMPTY
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

fn normalize_feed_identity(value: &str, label: &str) -> Result<String, DomainError> {
    let normalized = value.trim_matches(is_js_trim_ws);
    if normalized.is_empty()
        || normalized.encode_utf16().count() > 256
        || has_projection_control_char(normalized)
    {
        let reason = match label {
            "Feed owner" => "Feed owner is invalid.",
            "Replication feed owner" => "Replication feed owner is invalid.",
            "Follow target" => "Follow target is invalid.",
            "Bookmark owner" => "Bookmark owner is invalid.",
            "Bookmark target" => "Bookmark target is invalid.",
            _ => "Feed identity is invalid.",
        };
        return Err(DomainError::chat("invalid-follow-target", reason));
    }
    Ok(normalized.to_owned())
}

fn normalize_bookmark_reason(
    reason: Option<&str>,
    required: bool,
) -> Result<Option<String>, DomainError> {
    let normalized = reason.map(|reason| reason.trim_matches(is_js_trim_ws));
    if normalized.is_some_and(|reason| reason.encode_utf16().count() > 2_000)
        || (required && normalized.is_none_or(str::is_empty))
    {
        return Err(DomainError::chat(
            "invalid-message-body",
            "Bookmark failure reason is invalid.",
        ));
    }
    Ok(normalized
        .filter(|reason| !reason.is_empty())
        .map(str::to_owned))
}

/// Stored title (`""` = untitled) + first message body -> display title. This
/// is shared with the runtime rebuild so write-time and repair header rows stay
/// byte-identical (`chatThreadTitle.ts`).
pub fn chat_thread_display_title(stored_title: &str, first_body: Option<&str>) -> String {
    if !stored_title.is_empty() {
        return stored_title.to_owned();
    }
    let Some(body) = first_body else {
        return UNTITLED_THREAD_FALLBACK_TITLE.to_owned();
    };
    let first_line_raw = body.split('\n').next().unwrap_or("");
    let mut collapsed = String::with_capacity(first_line_raw.len());
    let mut in_ws = false;
    for ch in first_line_raw.chars() {
        if ch.is_whitespace() {
            in_ws = true;
        } else {
            if in_ws && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            in_ws = false;
            collapsed.push(ch);
        }
    }
    let first_line = collapsed.trim();
    if first_line.is_empty() {
        return UNTITLED_THREAD_FALLBACK_TITLE.to_owned();
    }
    if first_line.chars().count() <= THREAD_SNIPPET_TITLE_MAX_CHARS {
        return first_line.to_owned();
    }
    let kept: String = first_line
        .chars()
        .take(THREAD_SNIPPET_TITLE_MAX_CHARS.saturating_sub(1))
        .collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// Indexed message text (`chatIndexText`): author, optional agent marker, body.
pub fn chat_message_search_text(display_name: &str, is_agent: bool, body: &str) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(3);
    if !display_name.is_empty() {
        parts.push(display_name.to_owned());
        if is_agent {
            parts.push(format!("{display_name} (agent)"));
        }
    }
    if !body.is_empty() {
        parts.push(body.to_owned());
    }
    parts.join("\n")
}

/// The ONE delete-then-insert SQL implementation for a chat FTS row. Domain
/// writes call it inside their transaction; runtime rebuild/upsert wrappers call
/// the same helper so the two maintenance paths cannot drift.
pub fn upsert_chat_search_index_row(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    text: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM engine_search_chat_messages_fts \
         WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
        params![workspace_id, thread_id, message_id],
    )?;
    conn.execute(
        "INSERT INTO engine_search_chat_messages_fts \
         (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
        params![workspace_id, thread_id, message_id, text],
    )?;
    Ok(())
}

/// `normalizeChannelName`: NFC then trim, 1..=80 chars, no control chars.
fn normalize_channel_name(name: &str) -> Result<String, DomainError> {
    let normalized = nfc(name);
    let normalized = normalized.trim().to_owned();
    let count = normalized.chars().count();
    if normalized.is_empty()
        || count > MAX_CHANNEL_NAME_CHARS
        || has_projection_control_char(&normalized)
    {
        return Err(DomainError::chat(
            "invalid-channel-name",
            "Channel name must be 1-80 characters without control characters.",
        ));
    }
    Ok(normalized)
}

/// `normalizeOptionalThreadTitle`: absent/blank -> "" (untitled); else validated.
fn normalize_optional_thread_title(title: Option<&str>) -> Result<String, DomainError> {
    match title {
        None => Ok(String::new()),
        Some(t) if t.trim().is_empty() => Ok(String::new()),
        Some(t) => {
            let normalized = t.trim().to_owned();
            if normalized.chars().count() > MAX_THREAD_TITLE_CHARS {
                return Err(DomainError::chat(
                    "invalid-thread-title",
                    "Thread title is required.",
                ));
            }
            Ok(normalized)
        }
    }
}

/// `normalizeDisplayName`: trim, 1..=200 chars.
fn normalize_display_name(display_name: &str) -> Result<String, DomainError> {
    let normalized = display_name.trim();
    if normalized.is_empty() || normalized.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(DomainError::chat(
            "invalid-sender",
            "Chat sender display name is required.",
        ));
    }
    Ok(normalized.to_owned())
}

/// `normalizeAuthorUserId`: absent -> None; else trim, 1..=200 chars.
fn normalize_author_user_id(value: Option<&str>) -> Result<Option<String>, DomainError> {
    match value {
        None => Ok(None),
        Some(v) => {
            let normalized = v.trim();
            if normalized.is_empty() || normalized.chars().count() > MAX_AUTHOR_USER_ID_CHARS {
                return Err(DomainError::chat(
                    "invalid-sender",
                    "Chat author user id is invalid.",
                ));
            }
            Ok(Some(normalized.to_owned()))
        }
    }
}

/// `normalizeBody`: CRLF/CR -> LF, trimEnd, non-empty, <= 64 KiB UTF-8.
fn normalize_body(body: &str) -> Result<String, DomainError> {
    let lf = body.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = lf.trim_end_matches(is_js_trim_ws).to_owned();
    if normalized.is_empty() || normalized.len() > MAX_MESSAGE_BODY_BYTES {
        return Err(DomainError::chat(
            "invalid-message-body",
            "Message body is required.",
        ));
    }
    Ok(normalized)
}

/// The ECMAScript `String.prototype.trimEnd` whitespace set (WhiteSpace +
/// LineTerminator), so a normalized body is byte-identical to the TS
/// `normalizeBody`. It differs from Rust's `char::is_whitespace` (Unicode
/// `White_Space`) at exactly two code points: JS trims U+FEFF (ZWNBSP) which is
/// NOT `White_Space`, and JS does NOT trim U+0085 (NEL) which IS `White_Space`.
fn is_js_trim_ws(c: char) -> bool {
    c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{0085}')
}

/// `normalizeMessageOrigin`: absent -> None; only "cli" is accepted.
fn normalize_origin(origin: Option<&str>) -> Result<Option<String>, DomainError> {
    match origin {
        None => Ok(None),
        Some("cli") => Ok(Some("cli".to_owned())),
        Some(_) => Err(DomainError::chat(
            "invalid-message-body",
            "Message origin is invalid.",
        )),
    }
}

fn normalize_read_sequence(value: i64) -> Result<i64, DomainError> {
    if value < 0 {
        return Err(DomainError::chat(
            "invalid-read-cursor",
            "Read cursor sequence must be a non-negative integer.",
        ));
    }
    Ok(value)
}

// ----------------------------------------------------------------------- store

/// The chats domain bound to one workspace store. Cheap to construct per call;
/// holds only a mutable borrow of the writer.
pub struct LinkedChatStore<'a> {
    store: &'a mut EngineStore,
}

impl<'a> LinkedChatStore<'a> {
    /// Bind the domain to a storage writer.
    pub fn new(store: &'a mut EngineStore) -> Self {
        LinkedChatStore { store }
    }

    // -------------------------------------------------------------- channels

    /// Create a channel: reserved-slug rules, per-workspace slug uniqueness, and
    /// a wire-id mapping to its own channel id (`createChannel`). `agent` kind is
    /// rejected (agent channels are provisioned via [`Self::ensure_agent_channel`]).
    pub fn create_channel(
        &mut self,
        workspace_id: &str,
        channel_id: &str,
        name: &str,
        kind: ChatChannelKind,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatChannel, DomainError> {
        non_empty(
            workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let channel_id = normalize_replicated_chat_id(channel_id, "channel id is invalid")?;
        if matches!(
            channel_id.as_str(),
            GENERAL_CHANNEL_WIRE_ID | AGENT_CHANNEL_WIRE_ID
        ) {
            return Err(DomainError::InvalidInput {
                reason: "channel id is reserved",
            });
        }
        let name = normalize_channel_name(name)?;
        if kind == ChatChannelKind::Agent {
            return Err(DomainError::chat(
                "invalid-channel-kind",
                "Agent channels are provisioned automatically.",
            ));
        }
        let slug = channel_slug_for_name(&name);
        if slug.is_empty() {
            return Err(DomainError::chat(
                "invalid-channel-name",
                "Channel name must contain at least one letter or number.",
            ));
        }
        if slug == channel_slug_for_name(AGENT_CHANNEL_NAME) {
            return Err(DomainError::chat(
                "channel-exists",
                "The My agent channel name is reserved.",
            ));
        }

        let ws = workspace_id.to_owned();
        let cid = channel_id;
        let slug_c = slug.clone();
        let name_c = name.clone();
        let outcome = self.store.write_with(faults, |tx| {
            if channel_by_slug(tx, &ws, &slug_c)?.is_some() {
                return Err(DomainError::chat(
                    "channel-exists",
                    "A channel with that name already exists.",
                ));
            }
            // Persist the validated kind (`channel` or `dm`) — NOT hardcoded:
            // DM privacy depends on the stored kind (`list_personal_feed`
            // suppresses `c.kind = 'dm'`), so a requested DM must stay a DM.
            insert_channel(tx, &ws, &cid, &name_c, &slug_c, kind, now_ms)?;
            // A locally created channel's wire identity is its own id.
            record_channel_wire_id(tx, &ws, &cid, &cid)?;
            journal_local_op_in_tx(
                tx,
                &ws,
                "chat.channel.create",
                &serde_json::json!({
                    "channelId": cid,
                    "name": name_c,
                    "slug": slug_c,
                    "kind": kind.as_str(),
                    "createdAtMs": now_ms,
                    "wireId": cid,
                }),
                now_ms,
            )?;
            journal(tx, &cid, "chat.channel.create", now_ms)?;
            Ok::<_, DomainError>(ChatChannel {
                workspace_id: ws.clone(),
                channel_id: cid.clone(),
                name: name_c.clone(),
                slug: slug_c.clone(),
                kind,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            })
        })?;
        committed(outcome)
    }

    /// Idempotently ensure the well-known `general` channel exists, converging on
    /// the deterministic [`GENERAL_CHANNEL_WIRE_ID`] (`ensureGeneralChannel`).
    pub fn ensure_general_channel(
        &mut self,
        workspace_id: &str,
        channel_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatChannel, DomainError> {
        self.ensure_well_known_channel(
            workspace_id,
            channel_id,
            GENERAL_CHANNEL_NAME,
            GENERAL_CHANNEL_WIRE_ID,
            ChatChannelKind::Channel,
            now_ms,
            faults,
        )
    }

    /// Idempotently ensure the reserved `My agent` channel exists, converging on
    /// the deterministic [`AGENT_CHANNEL_WIRE_ID`] (`ensureAgentChannel`).
    pub fn ensure_agent_channel(
        &mut self,
        workspace_id: &str,
        channel_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatChannel, DomainError> {
        self.ensure_well_known_channel(
            workspace_id,
            channel_id,
            AGENT_CHANNEL_NAME,
            AGENT_CHANNEL_WIRE_ID,
            ChatChannelKind::Agent,
            now_ms,
            faults,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_well_known_channel(
        &mut self,
        workspace_id: &str,
        channel_id: &str,
        name: &str,
        wire_id: &str,
        kind: ChatChannelKind,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatChannel, DomainError> {
        non_empty(
            workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        // Same replicated-id bounds create_channel applies: a well-known
        // channel journals chat.channel.create too, and a control-bearing or
        // over-long id would wedge every receiving replica.
        let channel_id = normalize_replicated_chat_id(channel_id, "channel id is invalid")?;
        // Same reservation create_channel enforces: a LOCAL channel id equal
        // to a well-known WIRE id would poison channel-wire lookups and
        // thread payloads under sync.
        if matches!(
            channel_id.as_str(),
            GENERAL_CHANNEL_WIRE_ID | AGENT_CHANNEL_WIRE_ID
        ) {
            return Err(DomainError::InvalidInput {
                reason: "channel id is reserved",
            });
        }
        let slug = channel_slug_for_name(name);
        let ws = workspace_id.to_owned();
        let cid = channel_id.clone();
        let slug_c = slug.clone();
        let name_c = name.to_owned();
        let wire = wire_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            if let Some(existing) = channel_by_slug(tx, &ws, &slug_c)? {
                // Backfill the well-known wire mapping so imported rows converge.
                record_channel_wire_id(tx, &ws, &wire, &existing.channel_id)?;
                if kind == ChatChannelKind::Agent
                    && (existing.kind != ChatChannelKind::Agent || existing.name != name_c)
                {
                    return Err(DomainError::chat(
                        "channel-exists",
                        "The reserved My agent channel name is already in use.",
                    ));
                }
                return Ok::<_, DomainError>(existing);
            }
            insert_channel(tx, &ws, &cid, &name_c, &slug_c, kind, now_ms)?;
            record_channel_wire_id(tx, &ws, &wire, &cid)?;
            journal_local_op_in_tx(
                tx,
                &ws,
                "chat.channel.create",
                &serde_json::json!({
                    "channelId": cid,
                    "name": name_c,
                    "slug": slug_c,
                    "kind": kind.as_str(),
                    "createdAtMs": now_ms,
                    "wireId": wire,
                }),
                now_ms,
            )?;
            journal(tx, &cid, "chat.channel.create", now_ms)?;
            Ok::<_, DomainError>(ChatChannel {
                workspace_id: ws.clone(),
                channel_id: cid.clone(),
                name: name_c.clone(),
                slug: slug_c.clone(),
                kind,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            })
        })?;
        committed(outcome)
    }

    /// List channels, hiding placeholder channels (a replicated thread's guessed
    /// channel is invisible until its authoritative create arrives —
    /// `listChannels`). Ordered by `(created_at_ms, channel_id)`.
    pub fn list_channels(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChatChannelSummary>, DomainError> {
        self.store.read_with(|conn| {
            let corrupt_read_state = conn
                .query_row(
                    "SELECT 1 FROM chat_thread_read_state \
                     WHERE workspace_id = ?1 \
                       AND (last_read_sequence < 0 \
                            OR last_read_sequence <> CAST(last_read_sequence AS INTEGER) \
                            OR revision < 0 \
                            OR revision <> CAST(revision AS INTEGER)) \
                     LIMIT 1",
                    params![workspace_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if corrupt_read_state.is_some() {
                return Err(DomainError::chat(
                    "state-corrupt",
                    "Linked chat store is corrupt.",
                ));
            }
            let mut stmt = conn
                .prepare_cached(
                    "SELECT ch.workspace_id, ch.channel_id, ch.name, ch.slug, ch.kind, \
                            ch.created_at_ms, ch.updated_at_ms, \
                            COALESCE(agg.thread_count, 0), COALESCE(agg.unread_count, 0) \
                     FROM chat_channels ch \
                     LEFT JOIN ( \
                       SELECT t.workspace_id, t.channel_id, COUNT(*) AS thread_count, \
                              SUM(MAX( \
                                (SELECT COUNT(*) FROM chat_messages m \
                                 WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id) \
                                - COALESCE((SELECT rs.last_read_sequence \
                                            FROM chat_thread_read_state rs \
                                            WHERE rs.workspace_id = t.workspace_id \
                                              AND rs.thread_id = t.thread_id), 0), \
                                0)) AS unread_count \
                       FROM chat_threads t \
                       WHERE t.channel_id IS NOT NULL \
                       GROUP BY t.workspace_id, t.channel_id \
                     ) agg ON agg.workspace_id = ch.workspace_id AND agg.channel_id = ch.channel_id \
                     WHERE ch.workspace_id = ?1 \
                       AND NOT EXISTS (SELECT 1 FROM chat_channel_placeholders p \
                         WHERE p.workspace_id = ch.workspace_id AND p.channel_id = ch.channel_id) \
                     ORDER BY ch.created_at_ms, ch.channel_id LIMIT ?2",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, MAX_LIST_ROWS], |row| {
                    let channel = map_channel_row(row)?;
                    let thread_count = row.get(7)?;
                    let unread_count = row.get(8)?;
                    Ok(channel.map(|channel| ChatChannelSummary {
                        channel,
                        thread_count,
                        unread_count,
                    }))
                })
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Find a non-placeholder channel by slug (`findChannelBySlug`). The input is
    /// run through [`channel_slug_for_name`] first, so a display-name-like value
    /// (`"Client ACME  Launch"`) resolves the channel stored under its derived
    /// slug (`client-acme-launch`), matching the TS lookup. A value that derives
    /// an empty slug matches nothing.
    pub fn find_channel_by_slug(
        &self,
        workspace_id: &str,
        slug: &str,
    ) -> Result<Option<ChatChannel>, DomainError> {
        let slug = channel_slug_for_name(slug);
        if slug.is_empty() {
            return Ok(None);
        }
        self.store.read_with(|conn| {
            let found = channel_by_slug(conn, workspace_id, &slug)?;
            match found {
                Some(ch) if !channel_is_placeholder(conn, workspace_id, &ch.channel_id)? => {
                    Ok(Some(ch))
                }
                _ => Ok(None),
            }
        })
    }

    /// Return the stable cross-machine wire identity for a local channel id.
    /// An existing channel without a mapping resolves to `None`; an unknown
    /// channel is rejected by the same precheck as the TS store.
    pub fn get_channel_wire_id(
        &self,
        workspace_id: &str,
        channel_id: &str,
    ) -> Result<Option<String>, DomainError> {
        self.store.read_with(|conn| {
            let channel = require_channel(conn, workspace_id, channel_id)?;
            wire_id_for_channel_id(conn, workspace_id, &channel.channel_id)
        })
    }

    // ------------------------------------------------------- threads/messages

    /// Atomically create a channel thread AND its first message in ONE
    /// transaction (`startChannelThread`). A failed send never strands an empty
    /// thread: the thread row, the message row (order 0), the read-cursor
    /// advance (for a human author), and both journal entries commit together or
    /// not at all.
    pub fn start_channel_thread(
        &mut self,
        input: &StartChannelThread,
        faults: &dyn FaultInjector,
    ) -> Result<(ChatThread, ChatMessage), DomainError> {
        non_empty(
            &input.workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let thread_id = normalize_replicated_chat_id(&input.thread_id, "thread id is invalid")?;
        validate_message_id(&input.message_id)?;
        if input.message_id == CHAT_THREAD_HEADER_MESSAGE_ID {
            return Err(DomainError::InvalidInput {
                reason: "message id is reserved",
            });
        }
        let title = normalize_optional_thread_title(input.title.as_deref())?;
        let display_name = normalize_display_name(&input.author_display_name)?;
        let author_user_id = normalize_author_user_id(input.author_user_id.as_deref())?;
        let origin = normalize_origin(input.origin.as_deref())?;
        let body = normalize_body(&input.body)?;
        let now = input.now_ms;

        let payload_hash = hash_fields(&[
            thread_id.as_bytes(),
            input.message_id.as_bytes(),
            input.channel_id.as_bytes(),
            title.as_bytes(),
            body.as_bytes(),
            input.author_kind.as_str().as_bytes(),
            display_name.as_bytes(),
            author_user_id.as_deref().unwrap_or("").as_bytes(),
            origin.as_deref().unwrap_or("").as_bytes(),
        ]);
        // Exactly-once pre-check (single-writer: authoritative). A committed
        // retry replays the recorded thread+message instead of hitting the PK.
        if let Some(request_id) = &input.request_id
            && let Some(recorded) = self
                .store
                .read_with(|conn| lookup_request(conn, request_id))?
        {
            if recorded != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.reconstruct_thread_message(
                &input.workspace_id,
                &thread_id,
                &input.message_id,
            );
        }

        let mut input = input.clone();
        input.thread_id = thread_id;
        let title_c = title.clone();
        let body_c = body.clone();
        let display_c = display_name.clone();
        let author_user_c = author_user_id.clone();
        let origin_c = origin.clone();
        let outcome = self.store.write_with(faults, |tx| {
            let channel = require_channel(tx, &input.workspace_id, &input.channel_id)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id, thread_id, title, created_at_ms, updated_at_ms, \
                  linked_object_id, linked_path_hint, linked_at_ms, channel_id) \
                 VALUES (?1, ?2, ?3, ?4, ?4, NULL, NULL, NULL, ?5)",
                params![input.workspace_id, input.thread_id, title_c, now, channel.channel_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id, thread_id, message_order, message_id, author_kind, \
                  author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms) \
                 VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)",
                params![
                    input.workspace_id,
                    input.thread_id,
                    input.message_id,
                    input.author_kind.as_str(),
                    display_c,
                    author_user_c,
                    origin_c,
                    body_c,
                    now,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            mark_live_bookmarks_pending(tx, &input.workspace_id, &input.thread_id, now)?;
            if input.author_kind == ChatActorKind::Human {
                advance_read_cursor(tx, &input.workspace_id, &input.thread_id, 1, now, None)?;
            }
            let display_title = chat_thread_display_title(&title_c, Some(&body_c));
            upsert_chat_search_index_row(
                tx,
                &input.workspace_id,
                &input.thread_id,
                CHAT_THREAD_HEADER_MESSAGE_ID,
                &display_title,
            )
            .map_err(DomainError::sql_persist)?;
            let message_search_text = chat_message_search_text(
                &display_c,
                input.author_kind == ChatActorKind::Agent,
                &body_c,
            );
            upsert_chat_search_index_row(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                &message_search_text,
            )
            .map_err(DomainError::sql_persist)?;
            let channel_wire_id = wire_id_for_channel_id(
                tx,
                &input.workspace_id,
                &channel.channel_id,
            )?;
            let mut thread_payload = serde_json::json!({
                "threadId": input.thread_id,
                "title": title_c,
                "createdAtMs": now,
                "channelSlug": channel.slug,
            });
            if let Some(channel_wire_id) = channel_wire_id {
                thread_payload
                    .as_object_mut()
                    .expect("thread payload is an object")
                    .insert("channelWireId".to_owned(), serde_json::json!(channel_wire_id));
            }
            journal_local_op_in_tx(
                tx,
                &input.workspace_id,
                "chat.thread.create",
                &thread_payload,
                now,
            )?;
            let mut message_payload = serde_json::json!({
                "messageId": input.message_id,
                "threadId": input.thread_id,
                "authorKind": input.author_kind.as_str(),
                "authorDisplayName": display_c,
                "body": body_c,
                "createdAtMs": now,
            });
            let message_payload = message_payload
                .as_object_mut()
                .expect("message payload is an object");
            if let Some(author_user_id) = &author_user_c {
                message_payload.insert("authorUserId".to_owned(), serde_json::json!(author_user_id));
            }
            if let Some(origin) = &origin_c {
                message_payload.insert("origin".to_owned(), serde_json::json!(origin));
            }
            journal_local_op_in_tx(
                tx,
                &input.workspace_id,
                "chat.message.append",
                &serde_json::Value::Object(message_payload.clone()),
                now,
            )?;
            journal(tx, &input.thread_id, "chat.thread.create", now)?;
            journal(tx, &input.message_id, "chat.message.append", now)?;
            record_request(tx, input.request_id.as_deref(), &payload_hash, now)?;
            let thread = ChatThread {
                workspace_id: input.workspace_id.clone(),
                thread_id: input.thread_id.clone(),
                title: display_title,
                created_at_ms: now,
                updated_at_ms: now,
                channel_id: Some(channel.channel_id.clone()),
                linked_object_id: None,
            };
            let message = ChatMessage {
                workspace_id: input.workspace_id.clone(),
                thread_id: input.thread_id.clone(),
                message_id: input.message_id.clone(),
                message_order: 0,
                author_kind: input.author_kind,
                author_display_name: display_c.clone(),
                author_user_id: author_user_c.clone(),
                parent_message_id: None,
                origin: origin_c.clone(),
                body: body_c.clone(),
                created_at_ms: now,
            };
            Ok::<_, DomainError>((thread, message))
        })?;
        committed(outcome)
    }

    /// Append a message to an existing thread (`sendMessage`). A reply parent, if
    /// given, must already exist in the SAME thread (else `message-not-found`).
    pub fn send_message(
        &mut self,
        input: &SendMessage,
        faults: &dyn FaultInjector,
    ) -> Result<ChatMessage, DomainError> {
        non_empty(
            &input.workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        non_empty(
            &input.thread_id,
            "invalid-thread-title",
            "thread_id must not be empty",
        )?;
        validate_message_id(&input.message_id)?;
        if input.message_id == CHAT_THREAD_HEADER_MESSAGE_ID {
            return Err(DomainError::InvalidInput {
                reason: "message id is reserved",
            });
        }
        let display_name = normalize_display_name(&input.author_display_name)?;
        let author_user_id = normalize_author_user_id(input.author_user_id.as_deref())?;
        let origin = normalize_origin(input.origin.as_deref())?;
        let parent = match &input.parent_message_id {
            None => None,
            Some(p) if p.is_empty() => {
                return Err(DomainError::chat(
                    "invalid-message-body",
                    "Parent message id is invalid.",
                ));
            }
            Some(p) => Some(p.clone()),
        };
        let body = normalize_body(&input.body)?;
        let now = input.now_ms;

        let payload_hash = hash_fields(&[
            input.thread_id.as_bytes(),
            input.message_id.as_bytes(),
            body.as_bytes(),
            input.author_kind.as_str().as_bytes(),
            display_name.as_bytes(),
            author_user_id.as_deref().unwrap_or("").as_bytes(),
            parent.as_deref().unwrap_or("").as_bytes(),
            origin.as_deref().unwrap_or("").as_bytes(),
        ]);
        if let Some(request_id) = &input.request_id
            && let Some(recorded) = self
                .store
                .read_with(|conn| lookup_request(conn, request_id))?
        {
            if recorded != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.reconstruct_message(&input.workspace_id, &input.message_id);
        }

        let input = input.clone();
        let display_c = display_name.clone();
        let author_user_c = author_user_id.clone();
        let origin_c = origin.clone();
        let body_c = body.clone();
        let parent_c = parent.clone();
        let outcome = self.store.write_with(faults, |tx| {
            require_thread(tx, &input.workspace_id, &input.thread_id)?;
            if let Some(parent_id) = &parent_c
                && !thread_has_message(tx, &input.workspace_id, &input.thread_id, parent_id)?
            {
                return Err(DomainError::chat(
                    "message-not-found",
                    "Reply parent was not found in this chat thread.",
                ));
            }
            let order = next_message_order(tx, &input.workspace_id, &input.thread_id)?;
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id, thread_id, message_order, message_id, author_kind, \
                  author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    input.workspace_id,
                    input.thread_id,
                    order,
                    input.message_id,
                    input.author_kind.as_str(),
                    display_c,
                    author_user_c,
                    parent_c,
                    origin_c,
                    body_c,
                    now,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "UPDATE chat_threads SET updated_at_ms = ?3 \
                 WHERE workspace_id = ?1 AND thread_id = ?2",
                params![input.workspace_id, input.thread_id, now],
            )
            .map_err(DomainError::sql_persist)?;
            // Any active live bookmark on this thread must reproject after a new
            // message (`markLiveBookmarksPending`), else the projection goes stale.
            mark_live_bookmarks_pending(tx, &input.workspace_id, &input.thread_id, now)?;
            // Single-user read-state rule: your own human reply is never unread —
            // catch the cursor up to this message's sequence (`order + 1`). Agent
            // replies are exactly what unread exists to surface, so they do not.
            if input.author_kind == ChatActorKind::Human {
                advance_read_cursor(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    order.saturating_add(1),
                    now,
                    None,
                )?;
            }
            let message_search_text = chat_message_search_text(
                &display_c,
                input.author_kind == ChatActorKind::Agent,
                &body_c,
            );
            upsert_chat_search_index_row(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                &message_search_text,
            )
            .map_err(DomainError::sql_persist)?;
            let mut payload = serde_json::json!({
                "messageId": input.message_id,
                "threadId": input.thread_id,
                "authorKind": input.author_kind.as_str(),
                "authorDisplayName": display_c,
                "body": body_c,
                "createdAtMs": now,
            });
            let payload = payload
                .as_object_mut()
                .expect("message payload is an object");
            if let Some(author_user_id) = &author_user_c {
                payload.insert("authorUserId".to_owned(), serde_json::json!(author_user_id));
            }
            if let Some(parent_message_id) = &parent_c {
                payload.insert(
                    "parentMessageId".to_owned(),
                    serde_json::json!(parent_message_id),
                );
            }
            if let Some(origin) = &origin_c {
                payload.insert("origin".to_owned(), serde_json::json!(origin));
            }
            journal_local_op_in_tx(
                tx,
                &input.workspace_id,
                "chat.message.append",
                &serde_json::Value::Object(payload.clone()),
                now,
            )?;
            journal(tx, &input.message_id, "chat.message.append", now)?;
            record_request(tx, input.request_id.as_deref(), &payload_hash, now)?;
            Ok::<_, DomainError>(ChatMessage {
                workspace_id: input.workspace_id.clone(),
                thread_id: input.thread_id.clone(),
                message_id: input.message_id.clone(),
                message_order: order,
                author_kind: input.author_kind,
                author_display_name: display_c.clone(),
                author_user_id: author_user_c.clone(),
                parent_message_id: parent_c.clone(),
                origin: origin_c.clone(),
                body: body_c.clone(),
                created_at_ms: now,
            })
        })?;
        committed(outcome)
    }

    /// Replay a previously-committed `start_channel_thread` for an exactly-once
    /// retry: reads the durable thread + message rows by their caller-supplied ids.
    fn reconstruct_thread_message(
        &self,
        workspace_id: &str,
        thread_id: &str,
        message_id: &str,
    ) -> Result<(ChatThread, ChatMessage), DomainError> {
        self.store.read_with(|conn| {
            let thread = require_thread(conn, workspace_id, thread_id)?;
            let message = require_message(conn, workspace_id, message_id)?;
            Ok((thread, message))
        })
    }

    /// Replay a previously-committed `send_message` for an exactly-once retry.
    fn reconstruct_message(
        &self,
        workspace_id: &str,
        message_id: &str,
    ) -> Result<ChatMessage, DomainError> {
        self.store
            .read_with(|conn| require_message(conn, workspace_id, message_id))
    }

    /// List threads in the workspace, ordered by `(created_at_ms, thread_id)`.
    pub fn list_threads(&self, workspace_id: &str) -> Result<Vec<ChatThread>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t.workspace_id, t.thread_id, t.title, t.created_at_ms, t.updated_at_ms, \
                     t.channel_id, t.linked_object_id, \
                     (SELECT m.body FROM chat_messages m \
                      WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                      ORDER BY m.created_at_ms, m.message_id LIMIT 1) \
                     FROM chat_threads t WHERE t.workspace_id = ?1 \
                     ORDER BY created_at_ms, thread_id LIMIT ?2",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, MAX_LIST_ROWS], map_thread_row)
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// A keyset page of a thread's messages, oldest first, with a `limit + 1`
    /// probe cursor over `message_order` (`versions-list-moments` discipline
    /// applied to chat). `after_message_order` continues a prior page. `limit` is
    /// clamped to [`MAX_MESSAGE_PAGE`] so a single call can never load an entire
    /// channel; the cursor pages the rest.
    pub fn list_messages(
        &self,
        workspace_id: &str,
        thread_id: &str,
        limit: i64,
        after_message_order: Option<i64>,
    ) -> Result<ChatMessagePage, DomainError> {
        if limit <= 0 {
            return Err(DomainError::chat(
                "invalid-read-cursor",
                "limit must be positive",
            ));
        }
        let limit = limit.min(MAX_MESSAGE_PAGE);
        self.store.read_with(|conn| {
            // Fail closed on an unknown thread (or one in another workspace) so a
            // bad coordinate is not indistinguishable from an empty real thread —
            // matching the write paths' `require_thread`.
            require_thread(conn, workspace_id, thread_id)?;
            let probe = limit.saturating_add(1);
            let after = after_message_order.unwrap_or(-1);
            let mut stmt = conn
                .prepare_cached(
                    "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
                     author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
                     FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
                       AND message_order > ?3 ORDER BY message_order ASC LIMIT ?4",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, thread_id, after, probe], map_message_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut messages: Vec<ChatMessage> = collect(rows)?;
            let next = if messages.len() as i64 > limit {
                messages.truncate(limit as usize);
                messages.last().map(|m| m.message_order)
            } else {
                None
            };
            Ok(ChatMessagePage {
                messages,
                next_after_message_order: next,
            })
        })
    }

    // ------------------------------------------------------------- read state

    /// Mark a thread read up to `up_to_sequence` (`markThreadRead`). The ONE
    /// cursor writer: optional CAS against `expected_revision`, monotonic (never
    /// moves backwards), clamped to the thread's real message count, and it
    /// repairs a tampered OVER-COUNT cursor in place (revision unchanged on a
    /// repair). Fails closed with `read-state-revision-mismatch` on a stale CAS.
    pub fn mark_thread_read(
        &mut self,
        workspace_id: &str,
        thread_id: &str,
        up_to_sequence: i64,
        expected_revision: Option<i64>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatThreadReadState, DomainError> {
        let up_to = normalize_read_sequence(up_to_sequence)?;
        if let Some(rev) = expected_revision
            && rev < 0
        {
            return Err(DomainError::chat(
                "invalid-read-cursor",
                "Expected read-state revision must be a non-negative integer.",
            ));
        }
        let ws = workspace_id.to_owned();
        let tid = thread_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            require_thread(tx, &ws, &tid)?;
            advance_read_cursor(tx, &ws, &tid, up_to, now_ms, expected_revision)
        })?;
        committed(outcome)
    }

    /// The current read state for a thread (`readStateForThread`), defaulting to
    /// `(0, 0, 0)` when no row exists.
    pub fn read_state(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ChatThreadReadState, DomainError> {
        self.store
            .read_with(|conn| read_state_for_thread(conn, workspace_id, thread_id))
    }

    // ---------------------------------------------------------- follows/feed

    /// LWW-upsert a follow register (`setFollow`). Relay journaling is gated on
    /// a verified replication owner matching the local feed owner.
    /// The winner is decided by `(updated_at_ms, unfollowed>following,
    /// origin_id, origin_seq)` — commutative, mirroring the replicated apply
    /// arm. Local LWW origins are derived in this write transaction and are
    /// never accepted from an RPC caller.
    pub fn set_follow(
        &mut self,
        input: &SetFollow,
        faults: &dyn FaultInjector,
    ) -> Result<ChatFollow, DomainError> {
        let owner_user_id = normalize_feed_identity(&input.owner_user_id, "Feed owner")?;
        let replication_owner_user_id = input
            .replication_owner_user_id
            .as_deref()
            .map(|owner| normalize_feed_identity(owner, "Replication feed owner"))
            .transpose()?;
        if let Some(replication_owner_user_id) = &replication_owner_user_id {
            if replication_owner_user_id != &owner_user_id {
                return Err(DomainError::chat(
                    "invalid-follow-target",
                    "Replication feed owner must match the local feed owner.",
                ));
            }
        }
        let target_id = normalize_feed_identity(&input.target_id, "Follow target")?;
        let mut input = input.clone();
        input.owner_user_id = owner_user_id;
        input.replication_owner_user_id = replication_owner_user_id;
        input.target_id = target_id;
        let outcome = self.store.write_with(faults, |tx| {
            match input.target_kind {
                FollowTargetKind::Channel => {
                    let kind: Option<String> = tx
                        .query_row(
                            "SELECT c.kind FROM chat_channel_wire_ids w \
                             JOIN chat_channels c \
                               ON c.workspace_id = w.workspace_id AND c.channel_id = w.channel_id \
                             WHERE w.workspace_id = ?1 AND w.wire_id = ?2",
                            params![input.workspace_id, input.target_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(DomainError::sql_corrupt)?;
                    if kind.as_deref().is_none_or(|kind| kind == "dm") {
                        return Err(DomainError::chat(
                            "invalid-follow-target",
                            "Channel is not followable.",
                        ));
                    }
                }
                FollowTargetKind::Thread => {
                    let thread = require_thread(tx, &input.workspace_id, &input.target_id)
                        .map_err(|error| match error {
                            DomainError::Chat { .. } => DomainError::chat(
                                "invalid-follow-target",
                                "Chat thread is not followable.",
                            ),
                            other => other,
                        })?;
                    if let Some(channel_id) = thread.channel_id {
                        let channel = require_channel(tx, &input.workspace_id, &channel_id)?;
                        if channel.kind == ChatChannelKind::Dm {
                            return Err(DomainError::chat(
                                "invalid-follow-target",
                                "DM threads are not followable.",
                            ));
                        }
                    }
                }
                FollowTargetKind::Person | FollowTargetKind::Agent => {
                    let author_kind = match input.target_kind {
                        FollowTargetKind::Agent => "agent",
                        FollowTargetKind::Person => "human",
                        _ => unreachable!(),
                    };
                    let found: Option<i64> = tx
                        .query_row(
                            "SELECT 1 FROM chat_messages m \
                             JOIN chat_threads t \
                               ON t.workspace_id = m.workspace_id AND t.thread_id = m.thread_id \
                             LEFT JOIN chat_channels c \
                               ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id \
                             WHERE m.workspace_id = ?1 AND m.author_user_id = ?2 \
                               AND m.author_kind = ?3 \
                               AND (t.channel_id IS NULL OR c.kind <> 'dm') \
                             LIMIT 1",
                            params![input.workspace_id, input.target_id, author_kind],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(DomainError::sql_corrupt)?;
                    if found.is_none() {
                        return Err(DomainError::chat(
                            "invalid-follow-target",
                            "Chat author is not followable.",
                        ));
                    }
                }
            }
            let prior_at_ms: Option<i64> = tx
                .query_row(
                    "SELECT updated_at_ms FROM chat_follows \
                     WHERE workspace_id = ?1 AND owner_user_id = ?2 \
                       AND target_kind = ?3 AND target_id = ?4",
                    params![
                        input.workspace_id,
                        input.owner_user_id,
                        input.target_kind.as_str(),
                        input.target_id
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let at_ms = input
                .now_ms
                .max(prior_at_ms.map_or(0, |prior| prior.saturating_add(1)));
            let (origin_id, origin_seq) =
                local_replication_coordinate(tx, &input.workspace_id, at_ms)?;
            upsert_follow_lww(tx, &input, at_ms, &origin_id, origin_seq)?;
            if input.replication_owner_user_id.is_some() {
                insert_local_replication_op(
                    tx,
                    &input.workspace_id,
                    &origin_id,
                    origin_seq,
                    "chat.follow.set",
                    &serde_json::json!({
                        "ownerUserId": input.owner_user_id,
                        "targetKind": input.target_kind.as_str(),
                        "targetId": input.target_id,
                        "state": input.state.as_str(),
                        "atMs": at_ms,
                    }),
                    at_ms,
                )?;
                journal(tx, &input.target_id, "chat.follow.set", at_ms)?;
            }
            require_follow(
                tx,
                &input.workspace_id,
                &input.owner_user_id,
                input.target_kind,
                &input.target_id,
            )
        })?;
        committed(outcome)
    }

    /// List a follow owner's ACTIVE (following) registers, ordered by
    /// `(target_kind, target_id)` (`listFollows`).
    pub fn list_follows(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        state: Option<&str>,
    ) -> Result<Vec<ChatFollow>, DomainError> {
        // The write path stores TRIMMED owners: a padded lookup must resolve
        // the same identity or the caller sees a silently empty list.
        let owner_user_id = normalize_feed_identity(owner_user_id, "follow owner")?;
        let owner_user_id = owner_user_id.as_str();
        // Oracle `listFollows`: an omitted state returns ALL rows — unfollow
        // tombstones included, which reseeding flows inspect — and a present
        // state must be one of the two follow states.
        if let Some(state) = state {
            if state != "following" && state != "unfollowed" {
                return Err(DomainError::chat(
                    "invalid-follow-target",
                    "Follow state is invalid.",
                ));
            }
        }
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT owner_user_id, target_kind, target_id, state, updated_at_ms, \
                     origin_id, origin_seq FROM chat_follows \
                     WHERE workspace_id = ?1 AND owner_user_id = ?2 \
                       AND (?3 IS NULL OR state = ?3) \
                     ORDER BY target_kind, target_id LIMIT ?4",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![workspace_id, owner_user_id, state, MAX_LIST_ROWS],
                    map_follow_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// LWW-upsert the feed read state (`markPersonalFeedSeen`). Journals
    /// `chat.feed.read.set`.
    pub fn mark_feed_seen(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        replication_owner_user_id: Option<&str>,
        head_cursor: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatFeedReadState, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Feed owner")?;
        let replication_owner_user_id = replication_owner_user_id
            .map(|owner| normalize_feed_identity(owner, "Replication feed owner"))
            .transpose()?;
        if let Some(replication_owner_user_id) = &replication_owner_user_id {
            if replication_owner_user_id != &owner_user_id {
                return Err(DomainError::chat(
                    "invalid-follow-target",
                    "Replication feed owner must match the local feed owner.",
                ));
            }
        }
        let cursor = decode_feed_cursor(head_cursor)?;
        let ws = workspace_id.to_owned();
        let owner = owner_user_id;
        let msg = cursor.message_id;
        let last_seen_created_at_ms = cursor.created_at_ms;
        let outcome = self.store.write_with(faults, |tx| {
            // Receiver-private read state must not be advanced past a coordinate
            // the owner cannot actually see: prove the (created_at_ms, message_id)
            // names a currently-visible feed item under the SAME predicate before
            // persisting (`markPersonalFeedSeen`), else a caller could mark
            // arbitrary future/DM/unfollowed messages as seen.
            if !feed_coordinate_visible(tx, &ws, &owner, last_seen_created_at_ms, &msg)? {
                return Err(DomainError::chat(
                    "invalid-follow-target",
                    "Feed cursor is stale or no longer visible.",
                ));
            }
            let current_updated_at_ms: Option<i64> = tx
                .query_row(
                    "SELECT updated_at_ms FROM chat_feed_read_state \
                     WHERE workspace_id = ?1 AND owner_user_id = ?2",
                    params![ws, owner],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let at_ms = now_ms.max(
                current_updated_at_ms.map_or(0, |current| current.saturating_add(1)),
            );
            let (origin_id, origin_seq) = local_replication_coordinate(tx, &ws, at_ms)?;
            tx.execute(
                "INSERT INTO chat_feed_read_state \
                 (workspace_id, owner_user_id, last_seen_created_at_ms, last_seen_message_id, \
                  updated_at_ms, origin_id, origin_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(workspace_id, owner_user_id) DO UPDATE SET \
                   last_seen_created_at_ms = excluded.last_seen_created_at_ms, \
                   last_seen_message_id = excluded.last_seen_message_id, \
                   updated_at_ms = excluded.updated_at_ms, \
                   origin_id = excluded.origin_id, origin_seq = excluded.origin_seq \
                 WHERE excluded.last_seen_created_at_ms > chat_feed_read_state.last_seen_created_at_ms \
                    OR (excluded.last_seen_created_at_ms = chat_feed_read_state.last_seen_created_at_ms \
                        AND excluded.last_seen_message_id > chat_feed_read_state.last_seen_message_id) \
                    OR (excluded.last_seen_created_at_ms = chat_feed_read_state.last_seen_created_at_ms \
                        AND excluded.last_seen_message_id = chat_feed_read_state.last_seen_message_id \
                        AND (excluded.updated_at_ms > chat_feed_read_state.updated_at_ms \
                          OR (excluded.updated_at_ms = chat_feed_read_state.updated_at_ms \
                              AND (excluded.origin_id > chat_feed_read_state.origin_id \
                                OR (excluded.origin_id = chat_feed_read_state.origin_id \
                                    AND excluded.origin_seq > chat_feed_read_state.origin_seq)))))",
                params![ws, owner, last_seen_created_at_ms, msg, at_ms, origin_id, origin_seq],
            )
            .map_err(DomainError::sql_persist)?;
            if replication_owner_user_id.is_some() {
                insert_local_replication_op(
                    tx,
                    &ws,
                    &origin_id,
                    origin_seq,
                    "chat.feed.read.set",
                    &serde_json::json!({
                        "ownerUserId": owner,
                        "lastSeenCreatedAtMs": last_seen_created_at_ms,
                        "lastSeenMessageId": msg,
                        "atMs": at_ms,
                    }),
                    at_ms,
                )?;
                journal(tx, &owner, "chat.feed.read.set", at_ms)?;
            }
            require_feed_read_state(tx, &ws, &owner)
        })?;
        committed(outcome)
    }

    /// A cursor-paged, cross-thread personal feed (`listPersonalFeed`), newest
    /// first, gated by the exact TS visibility predicate (DM/placeholder hidden;
    /// author/thread/channel follows). The cursor is unpadded base64url
    /// ([`encode_feed_cursor`]); a bad cursor fails closed as
    /// `invalid-follow-target`. Returns fully hydrated feed items while retaining
    /// the visibility query's coordinates for cursor semantics.
    pub fn list_personal_feed(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        limit: Option<i64>,
        cursor: Option<&str>,
    ) -> Result<ChatFeedPage, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Feed owner")?;
        let limit = limit.unwrap_or(FEED_LIMIT_DEFAULT);
        if !(1..=FEED_LIMIT_MAX).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-follow-target",
                "Feed page limit is invalid.",
            ));
        }
        let decoded = match cursor {
            None => None,
            Some(c) => Some(decode_feed_cursor(c)?),
        };
        self.store.read_with(|conn| {
            let probe = limit.saturating_add(1);
            let (after_created, after_msg) = match &decoded {
                Some(v) => (v.created_at_ms, v.message_id.clone()),
                None => (i64::MAX, String::new()),
            };
            let has_cursor = decoded.is_some() as i64;
            let mut stmt = conn
                .prepare_cached(PERSONAL_FEED_SQL)
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        owner_user_id,
                        has_cursor,
                        after_created,
                        after_msg,
                        probe
                    ],
                    |row| {
                        Ok(FeedCandidate {
                            message_id: row.get(0)?,
                            thread_id: row.get(1)?,
                            created_at_ms: row.get(2)?,
                        })
                    },
                )
                .map_err(DomainError::sql_corrupt)?;
            let mut candidates: Vec<FeedCandidate> = Vec::new();
            for row in rows {
                candidates.push(row.map_err(DomainError::sql_corrupt)?);
            }
            drop(stmt);
            let next_cursor = if candidates.len() as i64 > limit {
                candidates.truncate(limit as usize);
                candidates.last().map(|last| {
                    encode_feed_cursor(&FeedCursorValue {
                        created_at_ms: last.created_at_ms,
                        message_id: last.message_id.clone(),
                    })
                })
            } else {
                None
            };
            let mut items = Vec::with_capacity(candidates.len());
            for candidate in candidates {
                let message = require_message(conn, workspace_id, &candidate.message_id)?;
                if message.thread_id != candidate.thread_id
                    || message.created_at_ms != candidate.created_at_ms
                {
                    return Err(DomainError::StateCorrupt {
                        reason: "personal feed candidate changed during hydration",
                    });
                }
                let thread = require_thread(conn, workspace_id, &message.thread_id)?;
                let channel = match &thread.channel_id {
                    Some(channel_id) => Some(require_channel(conn, workspace_id, channel_id)?),
                    None => None,
                };
                if channel
                    .as_ref()
                    .is_some_and(|channel| channel.kind == ChatChannelKind::Dm)
                {
                    return Err(DomainError::StateCorrupt {
                        reason: "personal feed hydrated a DM channel",
                    });
                }
                let opening_message =
                    first_message_for_thread(conn, workspace_id, &thread.thread_id)?;
                let is_opening = opening_message
                    .as_ref()
                    .is_some_and(|opening| opening.message_id == message.message_id);
                let opening_message =
                    opening_message.filter(|opening| opening.message_id != message.message_id);
                let parent_message = match &message.parent_message_id {
                    Some(parent_message_id) => {
                        let parent = message_by_id(conn, workspace_id, parent_message_id)?;
                        if parent
                            .as_ref()
                            .is_some_and(|parent| parent.thread_id != thread.thread_id)
                        {
                            return Err(DomainError::StateCorrupt {
                                reason: "personal feed parent belongs to another thread",
                            });
                        }
                        parent
                    }
                    None => None,
                };
                let mut matched_by = Vec::new();
                if let Some(author_user_id) = &message.author_user_id {
                    let kind = match message.author_kind {
                        ChatActorKind::Agent => FollowTargetKind::Agent,
                        ChatActorKind::Human => FollowTargetKind::Person,
                    };
                    if active_follow_exists(
                        conn,
                        workspace_id,
                        &owner_user_id,
                        kind,
                        author_user_id,
                    )? {
                        matched_by.push(kind);
                    }
                }
                if active_follow_exists(
                    conn,
                    workspace_id,
                    &owner_user_id,
                    FollowTargetKind::Thread,
                    &thread.thread_id,
                )? {
                    matched_by.push(FollowTargetKind::Thread);
                }
                if is_opening
                    && let Some(channel) = &channel
                    && let Some(wire_id) =
                        wire_id_for_channel_id(conn, workspace_id, &channel.channel_id)?
                    && active_follow_exists(
                        conn,
                        workspace_id,
                        &owner_user_id,
                        FollowTargetKind::Channel,
                        &wire_id,
                    )?
                {
                    matched_by.push(FollowTargetKind::Channel);
                }
                items.push(ChatFeedItem {
                    message,
                    thread,
                    channel,
                    parent_message,
                    opening_message,
                    // Reactions are deliberately empty until the RPC-B2 domain is ported.
                    reactions: Vec::new(),
                    matched_by,
                });
            }
            let head = conn
                .query_row(
                    PERSONAL_FEED_SQL,
                    params![workspace_id, owner_user_id, 0, i64::MAX, "", 1],
                    |row| {
                        Ok(FeedCursorValue {
                            message_id: row.get(0)?,
                            created_at_ms: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let head_cursor = head.as_ref().map(encode_feed_cursor);
            let read_state = conn
                .query_row(
                    "SELECT workspace_id, owner_user_id, last_seen_created_at_ms, \
                            last_seen_message_id, updated_at_ms \
                     FROM chat_feed_read_state \
                     WHERE workspace_id = ?1 AND owner_user_id = ?2",
                    params![workspace_id, owner_user_id],
                    |row| {
                        Ok(ChatFeedReadState {
                            workspace_id: row.get(0)?,
                            owner_user_id: row.get(1)?,
                            last_seen_created_at_ms: row.get(2)?,
                            last_seen_message_id: row.get(3)?,
                            updated_at_ms: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            Ok(ChatFeedPage {
                items,
                next_cursor,
                head_cursor,
                read_state,
            })
        })
    }

    // ------------------------------------------------------------- bookmarks

    /// Save (upsert) a workspace-backed bookmark keyed by `(owner, target)` and
    /// queue a projection generation (`saveBookmark`). A new bookmark seeds an
    /// outbox row at generation 1 (`pending`); an existing bookmark bumps the
    /// generation-CAS token so a stale worker cannot mark it ready.
    pub fn save_bookmark(
        &mut self,
        input: &SaveBookmark,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmark, DomainError> {
        let owner_user_id = normalize_feed_identity(&input.owner_user_id, "Bookmark owner")?;
        let target_id = normalize_feed_identity(&input.target_id, "Bookmark target")?;
        // The destination is a user-write path a projection worker later
        // materializes, so it must clear the CANONICAL Check-A floor
        // (`normalizePathHint` → `validateUserWritePath`): iterative percent
        // decoding (%25/%2e/%2f/%5c until stable), absolute/traversal
        // rejection, and the full reserved/ignored set — and the NORMALIZED
        // form is what persists, exactly like the oracle stores
        // `result.normalized`. A weaker floor here would let a disguised path
        // like `%2e%2e/outside.md` ride into `chat_bookmarks`/outbox that the
        // TS projection writer then refuses, wedging the bookmark.
        // TRACKED only: a secret-classified destination (`.env`,
        // `secrets%252eenv`, ...) is structurally valid but the plaintext
        // projection flow refuses secret paths — persisting it would queue a
        // bookmark whose projection can only fail, and a plaintext bookmark
        // body must never be invited into secret space in the first place.
        let destination_path = match dohc_engine_files::classify_engine_file_path_normalized(
            &input.destination_path,
        ) {
            (dohc_engine_files::PathClassification::Tracked, Some(normalized)) => normalized,
            _ => {
                return Err(DomainError::chat(
                    "invalid-path",
                    "Bookmark destination path is invalid.",
                ));
            }
        };
        let mut input = input.clone();
        input.owner_user_id = owner_user_id;
        input.target_id = target_id;
        input.destination_path = destination_path;
        let now = input.now_ms;
        let outcome = self.store.write_with(faults, |tx| {
            // Resolve the thread (+ message) the bookmark targets.
            let (thread_id, message_id) = match input.target_kind {
                BookmarkTargetKind::Thread => {
                    let thread = require_thread(tx, &input.workspace_id, &input.target_id)?;
                    (thread.thread_id, None)
                }
                BookmarkTargetKind::Message => {
                    let thread_id: Option<String> = tx
                        .query_row(
                            "SELECT thread_id FROM chat_messages \
                             WHERE workspace_id = ?1 AND message_id = ?2",
                            params![input.workspace_id, input.target_id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(DomainError::sql_corrupt)?;
                    let thread_id = thread_id.ok_or_else(|| {
                        DomainError::chat("message-not-found", "Bookmark message was not found.")
                    })?;
                    require_thread(tx, &input.workspace_id, &thread_id)?;
                    (thread_id, Some(input.target_id.clone()))
                }
            };
            let existing: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT bookmark_id, destination_path, state FROM chat_bookmarks \
                     WHERE workspace_id = ?1 AND owner_user_id = ?2 \
                       AND target_kind = ?3 AND target_id = ?4",
                    params![
                        input.workspace_id,
                        input.owner_user_id,
                        input.target_kind.as_str(),
                        input.target_id
                    ],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let bookmark_id = if let Some((existing_id, prior_destination, prior_state)) = existing
            {
                let resets_projection =
                    prior_destination != input.destination_path || prior_state == "archived";
                tx.execute(
                    "UPDATE chat_bookmarks SET thread_id = ?3, message_id = ?4, mode = ?5, \
                       destination_path = ?6, state = 'active', updated_at_ms = ?7 \
                     WHERE workspace_id = ?1 AND bookmark_id = ?2",
                    params![
                        input.workspace_id,
                        existing_id,
                        thread_id,
                        message_id,
                        input.mode.as_str(),
                        input.destination_path,
                        now
                    ],
                )
                .map_err(DomainError::sql_persist)?;
                queue_bookmark_generation(tx, &input.workspace_id, &existing_id, now)?;
                if resets_projection {
                    tx.execute(
                        "UPDATE chat_bookmark_outbox SET projection_object_id = NULL \
                         WHERE workspace_id = ?1 AND bookmark_id = ?2",
                        params![input.workspace_id, existing_id],
                    )
                    .map_err(DomainError::sql_persist)?;
                }
                existing_id
            } else {
                let bookmark_id =
                    bookmark_id_for(&input.owner_user_id, input.target_kind, &input.target_id);
                tx.execute(
                    "INSERT INTO chat_bookmarks \
                     (workspace_id, bookmark_id, owner_user_id, target_kind, target_id, thread_id, \
                      message_id, mode, destination_path, state, created_at_ms, updated_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)",
                    params![
                        input.workspace_id,
                        bookmark_id,
                        input.owner_user_id,
                        input.target_kind.as_str(),
                        input.target_id,
                        thread_id,
                        message_id,
                        input.mode.as_str(),
                        input.destination_path,
                        now
                    ],
                )
                .map_err(DomainError::sql_persist)?;
                tx.execute(
                    "INSERT INTO chat_bookmark_outbox \
                     (workspace_id, bookmark_id, generation, projected_generation, \
                      projection_state, updated_at_ms) VALUES (?1, ?2, 1, 0, 'pending', ?3)",
                    params![input.workspace_id, bookmark_id, now],
                )
                .map_err(DomainError::sql_persist)?;
                bookmark_id
            };
            require_bookmark(tx, &input.workspace_id, &input.owner_user_id, &bookmark_id)
        })?;
        committed(outcome)
    }

    /// List an owner's bookmarks, newest-updated first (`listBookmarks`).
    pub fn list_bookmarks(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        state: Option<&str>,
    ) -> Result<Vec<ChatBookmark>, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        if let Some(state) = state {
            if state != "active" && state != "archived" {
                return Err(DomainError::chat(
                    "invalid-bookmark-target",
                    "Bookmark state is invalid.",
                ));
            }
        }
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(&format!(
                    "{BOOKMARK_SELECT} WHERE b.workspace_id = ?1 AND b.owner_user_id = ?2 \
                     AND (?3 IS NULL OR b.state = ?3) \
                     ORDER BY b.updated_at_ms DESC, b.bookmark_id LIMIT ?4"
                ))
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![workspace_id, owner_user_id, state, MAX_LIST_ROWS],
                    map_bookmark_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Point lookup (`findBookmark`): `None` when the bookmark does not
    /// exist for this owner.
    pub fn find_bookmark(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
    ) -> Result<Option<ChatBookmark>, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        let bookmark_id = normalize_feed_identity(bookmark_id, "Bookmark id")?;
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(&format!(
                    "{BOOKMARK_SELECT} WHERE b.workspace_id = ?1 AND b.owner_user_id = ?2                      AND b.bookmark_id = ?3"
                ))
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![workspace_id, owner_user_id, bookmark_id],
                    map_bookmark_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            Ok(collect(rows)?.into_iter().next())
        })
    }

    /// The projection worker's poll (`listPendingBookmarks`): pending-outbox
    /// bookmarks, oldest outbox update first, limit 1..=200 (default 50).
    pub fn list_pending_bookmarks(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<ChatBookmark>, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        let limit = limit.unwrap_or(50);
        if !(1..=200).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-bookmark-target",
                "Bookmark limit is invalid.",
            ));
        }
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(&format!(
                    "{BOOKMARK_SELECT} WHERE b.workspace_id = ?1 AND b.owner_user_id = ?2                      AND o.projection_state = 'pending'                      ORDER BY o.updated_at_ms, b.bookmark_id LIMIT ?3"
                ))
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, owner_user_id, limit], map_bookmark_row)
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Archive an active bookmark and queue the archive projection generation.
    /// Repeating the transition on an archived bookmark is idempotent.
    pub fn archive_bookmark(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmark, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        non_empty(
            bookmark_id,
            "invalid-bookmark-target",
            "Bookmark id is required.",
        )?;
        let ws = workspace_id.to_owned();
        let owner = owner_user_id;
        let bid = bookmark_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            let current = require_bookmark(tx, &ws, &owner, &bid)?;
            if current.state == "active" {
                tx.execute(
                    "UPDATE chat_bookmarks SET state = 'archived', updated_at_ms = ?3 \
                     WHERE workspace_id = ?1 AND bookmark_id = ?2",
                    params![ws, bid, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
                queue_bookmark_generation(tx, &ws, &bid, now_ms)?;
            }
            require_bookmark(tx, &ws, &owner, &bid)
        })?;
        committed(outcome)
    }

    /// Fence a pending bookmark generation into the failed state.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_bookmark_failed(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        generation: i64,
        failure_reason: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmarkTransition, DomainError> {
        self.mark_bookmark_terminal(
            workspace_id,
            owner_user_id,
            bookmark_id,
            generation,
            Some(failure_reason),
            true,
            "failed",
            now_ms,
            faults,
        )
    }

    /// Fence a pending bookmark generation into the stale state.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_bookmark_stale(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        generation: i64,
        failure_reason: Option<&str>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmarkTransition, DomainError> {
        self.mark_bookmark_terminal(
            workspace_id,
            owner_user_id,
            bookmark_id,
            generation,
            failure_reason,
            false,
            "stale",
            now_ms,
            faults,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn mark_bookmark_terminal(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        generation: i64,
        failure_reason: Option<&str>,
        reason_required: bool,
        projection_state: &'static str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmarkTransition, DomainError> {
        let ws = workspace_id.to_owned();
        let owner = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        let bid = bookmark_id.to_owned();
        let failure_reason = failure_reason.map(str::to_owned);
        let outcome = self.store.write_with(faults, |tx| {
            require_bookmark(tx, &ws, &owner, &bid)?;
            if !(1..=9_007_199_254_740_991).contains(&generation) {
                return Err(DomainError::chat(
                    "invalid-bookmark-target",
                    "Bookmark generation is invalid.",
                ));
            }
            let failure_reason =
                normalize_bookmark_reason(failure_reason.as_deref(), reason_required)?;
            let changed = tx
                .execute(
                    "UPDATE chat_bookmark_outbox \
                     SET projection_state = ?4, failure_reason = ?5, updated_at_ms = ?6 \
                     WHERE workspace_id = ?1 AND bookmark_id = ?2 AND generation = ?3 \
                       AND projection_state = 'pending'",
                    params![
                        ws,
                        bid,
                        generation,
                        projection_state,
                        failure_reason,
                        now_ms
                    ],
                )
                .map_err(DomainError::sql_persist)?;
            let bookmark = require_bookmark(tx, &ws, &owner, &bid)?;
            Ok::<_, DomainError>(ChatBookmarkTransition {
                bookmark,
                applied: changed == 1,
            })
        })?;
        committed(outcome)
    }

    /// Mark a bookmark projection ready, fenced by a generation CAS
    /// (`markBookmarkReady`): the outbox row flips to `ready` ONLY when the
    /// finished `generation` is still the current pending one. A stale worker
    /// (generation N after N+1 was queued) matches no row → `applied = false`,
    /// no lost update.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_bookmark_ready(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        generation: i64,
        projected_at_ms: i64,
        projection_object_id: Option<&str>,
        projection_path: Option<&str>,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmarkTransition, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        non_empty(
            bookmark_id,
            "invalid-bookmark-target",
            "Bookmark id is required.",
        )?;
        // Same bound as the failed/stale transitions: a generation above
        // JS Number.MAX_SAFE_INTEGER is a malformed coordinate (worker or
        // serialization bug) and must REFUSE, not read as merely stale.
        if !(1..=9_007_199_254_740_991).contains(&generation) {
            return Err(DomainError::chat(
                "invalid-bookmark-target",
                "Bookmark generation is invalid.",
            ));
        }
        let projection_identity = match (projection_object_id, projection_path) {
            (None, None) => None,
            (Some(object_id), Some(path)) => {
                let object_id = object_id.trim_matches(is_js_trim_ws);
                if object_id.is_empty()
                    || object_id.encode_utf16().count() > 256
                    || has_projection_control_char(object_id)
                {
                    return Err(DomainError::chat(
                        "invalid-bookmark-target",
                        "Bookmark projection object id is invalid.",
                    ));
                }
                crate::store::validate_path(path).map_err(|_| {
                    DomainError::chat(
                        "invalid-bookmark-target",
                        "Bookmark projection path is invalid.",
                    )
                })?;
                Some((object_id.to_owned(), path.to_owned()))
            }
            _ => {
                return Err(DomainError::chat(
                    "invalid-bookmark-target",
                    "Projection identity and path must be recorded together.",
                ));
            }
        };
        let ws = workspace_id.to_owned();
        let owner = owner_user_id;
        let bid = bookmark_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            let current = require_bookmark(tx, &ws, &owner, &bid)?;
            if let Some((projection_object_id, projection_path)) = &projection_identity
                && current.generation == generation
                && current.projection_state == "pending"
            {
                let claimed = tx
                    .execute(
                        "UPDATE chat_bookmark_outbox \
                         SET projection_object_id = ?4 \
                         WHERE workspace_id = ?1 AND bookmark_id = ?2 \
                           AND generation = ?3 AND projection_state = 'pending' \
                           AND (projection_object_id IS NULL OR projection_object_id = ?4) \
                           AND EXISTS ( \
                             SELECT 1 FROM chat_bookmarks b \
                             WHERE b.workspace_id = chat_bookmark_outbox.workspace_id \
                               AND b.bookmark_id = chat_bookmark_outbox.bookmark_id \
                               AND b.destination_path = ?5 \
                           )",
                        params![ws, bid, generation, projection_object_id, projection_path],
                    )
                    .map_err(DomainError::sql_persist)?;
                if claimed != 1 {
                    return Err(DomainError::chat(
                        "invalid-bookmark-target",
                        "Bookmark projection ownership no longer matches.",
                    ));
                }
            }
            let changed = tx
                .execute(
                    "UPDATE chat_bookmark_outbox \
                     SET projected_generation = ?3, projection_state = 'ready', \
                         last_projected_at_ms = ?4, failure_reason = NULL, updated_at_ms = ?4 \
                     WHERE workspace_id = ?1 AND bookmark_id = ?2 AND generation = ?3 \
                       AND projection_state = 'pending'",
                    params![ws, bid, generation, projected_at_ms],
                )
                .map_err(DomainError::sql_persist)?;
            let bookmark = require_bookmark(tx, &ws, &owner, &bid)?;
            Ok::<_, DomainError>(ChatBookmarkTransition {
                bookmark,
                applied: changed == 1,
            })
        })?;
        committed(outcome)
    }

    // ------------------------------------------------------------- dispatch

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
        let outcome = self.store.write_with(faults, |tx| {
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
    /// returns the claim. Idempotent: retrying the same RUNNING `run_id`
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
        let outcome = self.store.write_with(faults, |tx| {
            // A response can be lost after commit. Recover that exact durable
            // claim before the workspace-wide single-flight guard rejects it.
            if let Some(existing) = running_dispatch_claim(tx, &ws, &run)? {
                return Ok::<_, DomainError>(Some(existing));
            }
            // Run ids are globally unique by schema
            // (idx_agent_run_records_run_id); the oracle never collides
            // because it MINTS ids (freshRunId), while this wire contract
            // accepts caller ids for retry rehydration. Any remaining match
            // (another workspace, or an ENDED run in this one) must refuse
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
            // Single-writer guard: a run already RUNNING means no new claim.
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
        let outcome = self.store.write_with(faults, |tx| {
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
        let outcome = self.store.write_with(faults, |tx| {
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

// ============================================================================
// Free helpers (SQL over a borrowed connection/transaction).
// ============================================================================

/// The personal-feed candidate query: exact TS visibility predicate with a
/// keyset cursor gated by `?3` (has_cursor). Newest first.
const PERSONAL_FEED_SQL: &str = "\
SELECT m.message_id, m.thread_id, m.created_at_ms
FROM chat_messages m
JOIN chat_threads t ON t.workspace_id = m.workspace_id AND t.thread_id = m.thread_id
LEFT JOIN chat_channels c ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id
WHERE m.workspace_id = ?1
  AND (t.channel_id IS NULL OR c.kind <> 'dm')
  AND (t.channel_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM chat_channel_placeholders placeholder
    WHERE placeholder.workspace_id = t.workspace_id
      AND placeholder.channel_id = t.channel_id))
  AND (
    EXISTS (SELECT 1 FROM chat_follows f WHERE f.workspace_id = m.workspace_id
      AND f.owner_user_id = ?2 AND f.state = 'following'
      AND f.target_kind = CASE m.author_kind WHEN 'agent' THEN 'agent' ELSE 'person' END
      AND f.target_id = m.author_user_id)
    OR EXISTS (SELECT 1 FROM chat_follows f WHERE f.workspace_id = m.workspace_id
      AND f.owner_user_id = ?2 AND f.state = 'following'
      AND f.target_kind = 'thread' AND f.target_id = m.thread_id)
    OR (
      m.message_id = (SELECT first.message_id FROM chat_messages first
        WHERE first.workspace_id = m.workspace_id AND first.thread_id = m.thread_id
        ORDER BY first.created_at_ms, first.message_id LIMIT 1)
      AND EXISTS (SELECT 1 FROM chat_channel_wire_ids w
        JOIN chat_follows f ON f.workspace_id = w.workspace_id
          AND f.owner_user_id = ?2 AND f.state = 'following'
          AND f.target_kind = 'channel' AND f.target_id = w.wire_id
        WHERE w.workspace_id = t.workspace_id AND w.channel_id = t.channel_id))
  )
  AND (?3 = 0 OR (m.created_at_ms < ?4 OR (m.created_at_ms = ?4 AND m.message_id < ?5)))
ORDER BY m.created_at_ms DESC, m.message_id DESC
LIMIT ?6";

/// Single-coordinate visibility probe: the personal-feed predicate pinned to one
/// `(message_id ?3, created_at_ms ?4)` for owner `?2` in workspace `?1`
/// (`markPersonalFeedSeen`'s visibility gate).
const FEED_COORDINATE_VISIBLE_SQL: &str = "\
SELECT 1
FROM chat_messages m
JOIN chat_threads t ON t.workspace_id = m.workspace_id AND t.thread_id = m.thread_id
LEFT JOIN chat_channels c ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id
WHERE m.workspace_id = ?1 AND m.message_id = ?3 AND m.created_at_ms = ?4
  AND (t.channel_id IS NULL OR c.kind <> 'dm')
  AND (t.channel_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM chat_channel_placeholders placeholder
    WHERE placeholder.workspace_id = t.workspace_id
      AND placeholder.channel_id = t.channel_id))
  AND (
    EXISTS (SELECT 1 FROM chat_follows f WHERE f.workspace_id = m.workspace_id
      AND f.owner_user_id = ?2 AND f.state = 'following'
      AND f.target_kind = CASE m.author_kind WHEN 'agent' THEN 'agent' ELSE 'person' END
      AND f.target_id = m.author_user_id)
    OR EXISTS (SELECT 1 FROM chat_follows f WHERE f.workspace_id = m.workspace_id
      AND f.owner_user_id = ?2 AND f.state = 'following'
      AND f.target_kind = 'thread' AND f.target_id = m.thread_id)
    OR (
      m.message_id = (SELECT first.message_id FROM chat_messages first
        WHERE first.workspace_id = m.workspace_id AND first.thread_id = m.thread_id
        ORDER BY first.created_at_ms, first.message_id LIMIT 1)
      AND EXISTS (SELECT 1 FROM chat_channel_wire_ids w
        JOIN chat_follows f ON f.workspace_id = w.workspace_id
          AND f.owner_user_id = ?2 AND f.state = 'following'
          AND f.target_kind = 'channel' AND f.target_id = w.wire_id
        WHERE w.workspace_id = t.workspace_id AND w.channel_id = t.channel_id))
  )
LIMIT 1";

const BOOKMARK_SELECT: &str = "\
SELECT b.bookmark_id, b.owner_user_id, b.target_kind, b.target_id, b.thread_id, b.message_id, \
       b.mode, b.destination_path, b.state, b.created_at_ms, b.updated_at_ms, \
       o.generation, o.projected_generation, o.projection_state, o.last_projected_at_ms, \
       o.projection_object_id, o.failure_reason \
FROM chat_bookmarks b \
JOIN chat_bookmark_outbox o \
  ON o.workspace_id = b.workspace_id AND o.bookmark_id = b.bookmark_id";

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("crash fault fired before ack"),
        ))),
    }
}

fn collect<T>(
    rows: impl Iterator<Item = rusqlite::Result<Result<T, DomainError>>>,
) -> Result<Vec<T>, DomainError> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(DomainError::sql_corrupt)??);
    }
    Ok(out)
}

/// Requeue every ACTIVE `live` bookmark on a thread for reprojection after a new
/// message (`markLiveBookmarksPending`), so a live projection never goes
/// permanently stale. Bumps the generation-CAS token + resets `pending`.
fn mark_live_bookmarks_pending(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "UPDATE chat_bookmark_outbox \
         SET generation = generation + 1, projection_state = 'pending', \
             failure_reason = NULL, updated_at_ms = ?3 \
         WHERE workspace_id = ?1 AND bookmark_id IN ( \
           SELECT bookmark_id FROM chat_bookmarks \
           WHERE workspace_id = ?1 AND thread_id = ?2 AND mode = 'live' AND state = 'active')",
        params![workspace_id, thread_id, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Whether a `(created_at_ms, message_id)` coordinate names a message currently
/// visible to `owner_user_id` under the personal-feed predicate. Used to gate
/// `mark_feed_seen` so receiver-private read state can't skip past unseen items.
fn feed_coordinate_visible(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    created_at_ms: i64,
    message_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            FEED_COORDINATE_VISIBLE_SQL,
            params![workspace_id, owner_user_id, message_id, created_at_ms],
            |r| r.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn insert_channel(
    tx: &Transaction<'_>,
    workspace_id: &str,
    channel_id: &str,
    name: &str,
    slug: &str,
    kind: ChatChannelKind,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO chat_channels \
         (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![workspace_id, channel_id, name, slug, kind.as_str(), now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn record_channel_wire_id(
    conn: &Connection,
    workspace_id: &str,
    wire_id: &str,
    channel_id: &str,
) -> Result<(), DomainError> {
    conn.execute(
        "INSERT OR IGNORE INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) \
         VALUES (?1, ?2, ?3)",
        params![workspace_id, wire_id, channel_id],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn wire_id_for_channel_id(
    conn: &Connection,
    workspace_id: &str,
    channel_id: &str,
) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT wire_id FROM chat_channel_wire_ids \
         WHERE workspace_id = ?1 AND channel_id = ?2 ORDER BY wire_id LIMIT 1",
        params![workspace_id, channel_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn channel_by_slug(
    conn: &Connection,
    workspace_id: &str,
    slug: &str,
) -> Result<Option<ChatChannel>, DomainError> {
    conn.query_row(
        "SELECT workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms \
         FROM chat_channels WHERE workspace_id = ?1 AND slug = ?2",
        params![workspace_id, slug],
        map_channel_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()
}

fn channel_is_placeholder(
    conn: &Connection,
    workspace_id: &str,
    channel_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM chat_channel_placeholders WHERE workspace_id = ?1 AND channel_id = ?2",
            params![workspace_id, channel_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn require_channel(
    conn: &Connection,
    workspace_id: &str,
    channel_id: &str,
) -> Result<ChatChannel, DomainError> {
    conn.query_row(
        "SELECT workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms \
         FROM chat_channels WHERE workspace_id = ?1 AND channel_id = ?2",
        params![workspace_id, channel_id],
        map_channel_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("channel-not-found", "Chat channel was not found."))
}

fn require_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ChatThread, DomainError> {
    conn.query_row(
        "SELECT t.workspace_id, t.thread_id, t.title, t.created_at_ms, t.updated_at_ms, \
         t.channel_id, t.linked_object_id, \
         (SELECT m.body FROM chat_messages m \
          WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
          ORDER BY m.created_at_ms, m.message_id LIMIT 1) \
         FROM chat_threads t WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
        params![workspace_id, thread_id],
        map_thread_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("thread-not-found", "Chat thread was not found."))
}

fn thread_has_message(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
            params![workspace_id, thread_id, message_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn next_message_order(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<i64, DomainError> {
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(message_order) FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |r| r.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    Ok(max.map(|m| m.saturating_add(1)).unwrap_or(0))
}

fn message_count_for_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<i64, DomainError> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2",
        params![workspace_id, thread_id],
        |r| r.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

fn read_state_for_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ChatThreadReadState, DomainError> {
    let row: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT last_read_sequence, revision, updated_at_ms FROM chat_thread_read_state \
             WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    match row {
        None => Ok(ChatThreadReadState {
            workspace_id: workspace_id.to_owned(),
            thread_id: thread_id.to_owned(),
            last_read_sequence: 0,
            revision: 0,
            updated_at_ms: 0,
        }),
        Some((seq, revision, updated)) => {
            if seq < 0 || revision < 0 {
                return Err(DomainError::StateCorrupt {
                    reason: "chat read-state row holds a negative sequence/revision",
                });
            }
            Ok(ChatThreadReadState {
                workspace_id: workspace_id.to_owned(),
                thread_id: thread_id.to_owned(),
                last_read_sequence: seq,
                revision,
                updated_at_ms: updated,
            })
        }
    }
}

fn persist_read_state(
    tx: &Transaction<'_>,
    state: &ChatThreadReadState,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO chat_thread_read_state \
         (workspace_id, thread_id, last_read_sequence, revision, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(workspace_id, thread_id) DO UPDATE SET \
           last_read_sequence = excluded.last_read_sequence, \
           revision = excluded.revision, updated_at_ms = excluded.updated_at_ms",
        params![
            state.workspace_id,
            state.thread_id,
            state.last_read_sequence,
            state.revision,
            state.updated_at_ms
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// The ONE cursor writer (`advanceReadCursor`): optional CAS, monotonic, clamped
/// to the real message count, over-count repaired in place (revision unchanged).
fn advance_read_cursor(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    up_to_sequence: i64,
    now_ms: i64,
    expected_revision: Option<i64>,
) -> Result<ChatThreadReadState, DomainError> {
    let mut current = read_state_for_thread(tx, workspace_id, thread_id)?;
    if let Some(expected) = expected_revision
        && expected != current.revision
    {
        return Err(DomainError::chat(
            "read-state-revision-mismatch",
            "Read-state revision is stale.",
        ));
    }
    let message_count = message_count_for_thread(tx, workspace_id, thread_id)?;
    if current.last_read_sequence > message_count {
        // Repair a tampered OVER-COUNT cursor in place; the revision holds and
        // the repair is not an applied advance (updated_at_ms unchanged).
        current.last_read_sequence = message_count;
        persist_read_state(tx, &current)?;
    }
    let target = up_to_sequence.min(message_count);
    if target <= current.last_read_sequence {
        return Ok(current);
    }
    let next = ChatThreadReadState {
        workspace_id: workspace_id.to_owned(),
        thread_id: thread_id.to_owned(),
        last_read_sequence: target,
        revision: current.revision.saturating_add(1),
        updated_at_ms: now_ms,
    };
    persist_read_state(tx, &next)?;
    Ok(next)
}

fn upsert_follow_lww(
    tx: &Transaction<'_>,
    input: &SetFollow,
    at_ms: i64,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO chat_follows \
         (workspace_id, owner_user_id, target_kind, target_id, state, updated_at_ms, \
          origin_id, origin_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(workspace_id, owner_user_id, target_kind, target_id) DO UPDATE SET \
           state = excluded.state, updated_at_ms = excluded.updated_at_ms, \
           origin_id = excluded.origin_id, origin_seq = excluded.origin_seq \
         WHERE excluded.updated_at_ms > chat_follows.updated_at_ms \
            OR (excluded.updated_at_ms = chat_follows.updated_at_ms \
                AND (CASE excluded.state WHEN 'unfollowed' THEN 1 ELSE 0 END) > \
                    (CASE chat_follows.state WHEN 'unfollowed' THEN 1 ELSE 0 END)) \
            OR (excluded.updated_at_ms = chat_follows.updated_at_ms \
                AND excluded.state = chat_follows.state \
                AND (excluded.origin_id > chat_follows.origin_id \
                  OR (excluded.origin_id = chat_follows.origin_id \
                      AND excluded.origin_seq > chat_follows.origin_seq)))",
        params![
            input.workspace_id,
            input.owner_user_id,
            input.target_kind.as_str(),
            input.target_id,
            input.state.as_str(),
            at_ms,
            origin_id,
            origin_seq
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Return the local origin and the next sequence from the replication journal.
/// This is deliberately transaction-local: the LWW register must store the
/// exact coordinate that a local replication op would use, and RPC callers
/// must never be able to forge either half of it (`ensureOriginId` /
/// `nextOriginSeq`). SQLite supplies the random bytes so the domain needs no
/// caller-controlled or process-global identity seam.
fn local_replication_coordinate(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<(String, i64), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO sync_identity \
         (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
         VALUES (?1, 'origin_' || lower(hex(randomblob(16))), \
                 'epoch_' || lower(hex(randomblob(16))), \
                 'stream_' || lower(hex(randomblob(16))), ?2)",
        params![workspace_id, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    let origin_id: String = tx
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), -1) FROM replication_log \
             WHERE workspace_id = ?1 AND origin_id = ?2",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    let origin_seq = previous.checked_add(1).ok_or(DomainError::StateCorrupt {
        reason: "local replication origin sequence overflowed",
    })?;
    if origin_seq < 0 {
        return Err(DomainError::StateCorrupt {
            reason: "local replication origin sequence is corrupt",
        });
    }
    Ok((origin_id, origin_seq))
}

/// Consume a locally allocated LWW coordinate in the relay-visible log inside
/// the same transaction as the register update and compatibility journal row.
fn insert_local_replication_op(
    tx: &Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    op_kind: &str,
    payload: &serde_json::Value,
    recorded_at_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO replication_log \
         (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            workspace_id,
            origin_id,
            origin_seq,
            op_kind,
            payload.to_string(),
            recorded_at_ms
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Allocate and insert an ordinary relay-visible local op in the caller's
/// transaction. Unlike the receiver-private follow/read registers, core chat
/// creates are always exported.
fn journal_local_op_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
    recorded_at_ms: i64,
) -> Result<(), DomainError> {
    let (origin_id, origin_seq) = local_replication_coordinate(tx, workspace_id, recorded_at_ms)?;
    insert_local_replication_op(
        tx,
        workspace_id,
        &origin_id,
        origin_seq,
        op_kind,
        payload,
        recorded_at_ms,
    )
}

fn require_feed_read_state(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
) -> Result<ChatFeedReadState, DomainError> {
    conn.query_row(
        "SELECT workspace_id, owner_user_id, last_seen_created_at_ms, \
                last_seen_message_id, updated_at_ms \
         FROM chat_feed_read_state WHERE workspace_id = ?1 AND owner_user_id = ?2",
        params![workspace_id, owner_user_id],
        |row| {
            Ok(ChatFeedReadState {
                workspace_id: row.get(0)?,
                owner_user_id: row.get(1)?,
                last_seen_created_at_ms: row.get(2)?,
                last_seen_message_id: row.get(3)?,
                updated_at_ms: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .ok_or(DomainError::StateCorrupt {
        reason: "feed read-state upsert left no row",
    })
}

fn require_follow(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    target_kind: FollowTargetKind,
    target_id: &str,
) -> Result<ChatFollow, DomainError> {
    conn.query_row(
        "SELECT owner_user_id, target_kind, target_id, state, updated_at_ms, origin_id, origin_seq \
         FROM chat_follows WHERE workspace_id = ?1 AND owner_user_id = ?2 \
           AND target_kind = ?3 AND target_id = ?4",
        params![workspace_id, owner_user_id, target_kind.as_str(), target_id],
        map_follow_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or(DomainError::StateCorrupt {
        reason: "follow upsert left no row",
    })
}

fn queue_bookmark_generation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    bookmark_id: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    let changed = tx
        .execute(
            "UPDATE chat_bookmark_outbox \
             SET generation = generation + 1, projection_state = 'pending', \
                 failure_reason = NULL, updated_at_ms = ?3 \
             WHERE workspace_id = ?1 AND bookmark_id = ?2",
            params![workspace_id, bookmark_id, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    if changed != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "bookmark outbox generation bump matched no row",
        });
    }
    Ok(())
}

fn require_bookmark(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    bookmark_id: &str,
) -> Result<ChatBookmark, DomainError> {
    conn.query_row(
        &format!(
            "{BOOKMARK_SELECT} WHERE b.workspace_id = ?1 AND b.owner_user_id = ?2 \
             AND b.bookmark_id = ?3"
        ),
        params![workspace_id, owner_user_id, bookmark_id],
        map_bookmark_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("invalid-bookmark-target", "Bookmark was not found."))
}

fn require_message(
    conn: &Connection,
    workspace_id: &str,
    message_id: &str,
) -> Result<ChatMessage, DomainError> {
    conn.query_row(
        "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND message_id = ?2",
        params![workspace_id, message_id],
        map_message_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("message-not-found", "Chat message was not found."))
}

fn message_by_id(
    conn: &Connection,
    workspace_id: &str,
    message_id: &str,
) -> Result<Option<ChatMessage>, DomainError> {
    conn.query_row(
        "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND message_id = ?2",
        params![workspace_id, message_id],
        map_message_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()
}

fn first_message_for_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<Option<ChatMessage>, DomainError> {
    conn.query_row(
        "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
         ORDER BY created_at_ms, message_id LIMIT 1",
        params![workspace_id, thread_id],
        map_message_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()
}

fn active_follow_exists(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    target_kind: FollowTargetKind,
    target_id: &str,
) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT 1 FROM chat_follows WHERE workspace_id = ?1 AND owner_user_id = ?2 \
         AND target_kind = ?3 AND target_id = ?4 AND state = 'following' LIMIT 1",
        params![workspace_id, owner_user_id, target_kind.as_str(), target_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(DomainError::sql_corrupt)
}

/// Rehydrate a lost-response retry from the one RUNNING ledger row and its
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

fn journal(
    tx: &Transaction<'_>,
    doc_id: &str,
    op_kind: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) VALUES (?1, ?2, ?3)",
        params![doc_id, op_kind, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Look up a prior request's payload hash in the exactly-once ledger
/// (`engine_requests`), mirroring the versioning domain's idempotency seam.
fn lookup_request(conn: &Connection, request_id: &str) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT payload_hash FROM engine_requests WHERE request_id = ?1",
        params![request_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

/// Record the idempotency-ledger row in the SAME transaction as the mutation, so
/// a committed retry replays to the recorded result exactly-once. `result_seq`
/// is unused by chat replays (the result is rebuilt from the durable rows by
/// their caller-supplied ids), stored as 0.
fn record_request(
    tx: &Transaction<'_>,
    request_id: Option<&str>,
    payload_hash: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    if let Some(request_id) = request_id {
        // -1 keeps chat rows outside the moment-order domain entirely:
        // versioned rows carry result_seq = moment_order (orders start at 1,
        // `next_moment_order` is MAX+1) and rollback deletes by that value,
        // so a sentinel that can never equal an order is immune by
        // construction, not by the current numbering convention.
        tx.execute(
            "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at) \
             VALUES (?1, ?2, -1, ?3)",
            params![request_id, payload_hash, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}

/// Deterministic fingerprint over NUL-separated fields (idempotency payloads),
/// matching the versioning domain's `hash_fields`.
fn hash_fields(fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        hasher.update(field);
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

// -------------------------------------------------------------------- mappers

fn map_channel_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ChatChannel, DomainError>> {
    let workspace_id: String = row.get(0)?;
    let channel_id: String = row.get(1)?;
    let name: String = row.get(2)?;
    let slug: String = row.get(3)?;
    let kind_str: String = row.get(4)?;
    let created_at_ms: i64 = row.get(5)?;
    let updated_at_ms: i64 = row.get(6)?;
    Ok(ChatChannelKind::from_db(&kind_str).map(|kind| ChatChannel {
        workspace_id,
        channel_id,
        name,
        slug,
        kind,
        created_at_ms,
        updated_at_ms,
    }))
}

fn map_thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ChatThread, DomainError>> {
    let stored_title: String = row.get(2)?;
    let first_body: Option<String> = row.get(7)?;
    Ok(Ok(ChatThread {
        workspace_id: row.get(0)?,
        thread_id: row.get(1)?,
        title: chat_thread_display_title(&stored_title, first_body.as_deref()),
        created_at_ms: row.get(3)?,
        updated_at_ms: row.get(4)?,
        channel_id: row.get(5)?,
        linked_object_id: row.get(6)?,
    }))
}

fn map_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ChatMessage, DomainError>> {
    let workspace_id: String = row.get(0)?;
    let thread_id: String = row.get(1)?;
    let message_order: i64 = row.get(2)?;
    let message_id: String = row.get(3)?;
    let author_kind_str: String = row.get(4)?;
    let author_display_name: String = row.get(5)?;
    let author_user_id: Option<String> = row.get(6)?;
    let parent_message_id: Option<String> = row.get(7)?;
    let origin: Option<String> = row.get(8)?;
    let body: String = row.get(9)?;
    let created_at_ms: i64 = row.get(10)?;
    Ok(
        ChatActorKind::from_db(&author_kind_str).map(|author_kind| ChatMessage {
            workspace_id,
            thread_id,
            message_id,
            message_order,
            author_kind,
            author_display_name,
            author_user_id,
            parent_message_id,
            origin,
            body,
            created_at_ms,
        }),
    )
}

fn map_follow_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ChatFollow, DomainError>> {
    let owner_user_id: String = row.get(0)?;
    let target_kind_str: String = row.get(1)?;
    let target_id: String = row.get(2)?;
    let state_str: String = row.get(3)?;
    let updated_at_ms: i64 = row.get(4)?;
    let origin_id: String = row.get(5)?;
    let origin_seq: i64 = row.get(6)?;
    Ok((|| {
        Ok(ChatFollow {
            owner_user_id,
            target_kind: FollowTargetKind::from_db(&target_kind_str)?,
            target_id,
            state: FollowState::from_db(&state_str)?,
            updated_at_ms,
            origin_id,
            origin_seq,
        })
    })())
}

fn map_bookmark_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ChatBookmark, DomainError>> {
    Ok(Ok(ChatBookmark {
        bookmark_id: row.get(0)?,
        owner_user_id: row.get(1)?,
        target_kind: row.get(2)?,
        target_id: row.get(3)?,
        thread_id: row.get(4)?,
        message_id: row.get(5)?,
        mode: row.get(6)?,
        destination_path: row.get(7)?,
        state: row.get(8)?,
        created_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
        generation: row.get(11)?,
        projected_generation: row.get(12)?,
        projection_state: row.get(13)?,
        last_projected_at_ms: row.get(14)?,
        projection_object_id: row.get(15)?,
        failure_reason: row.get(16)?,
    }))
}
