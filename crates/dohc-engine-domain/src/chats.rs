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
use std::collections::{HashMap, HashSet};
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
/// Workspace-only emptiness probe used to skip the full pending replay scan.
pub const PENDING_CHAT_WORKSPACE_EXISTS_SQL: &str = "\
SELECT EXISTS( \
  SELECT 1 FROM chat_pending_replication \
  WHERE workspace_id=?1 LIMIT 1)";
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
/// Stable file-object ids are trimmed and bounded like `normalizeObjectId`.
const MAX_ATTACHMENT_OBJECT_ID_UTF16_UNITS: usize = 200;
/// Section-heading fields use the production attachment bounds.
const MAX_ATTACHMENT_HEADING_TEXT_UTF16_UNITS: usize = 300;
const MAX_ATTACHMENT_HEADING_ANCHOR_UTF16_UNITS: usize = 400;
/// Reaction emoji bound (`REACTION_EMOJI_MAX_CHARS`) in JavaScript UTF-16 units.
const MAX_REACTION_EMOJI_UTF16_UNITS: usize = 32;
/// Reaction author ids use the same bounded identity posture as relay user ids.
const MAX_REACTION_AUTHOR_ID_UTF16_UNITS: usize = 200;
/// Opening-message preview bound used by channel summaries.
const OPENING_MESSAGE_BODY_SNIPPET_UTF16_UNITS: usize = 500;
/// The logical file-mention lookup never exposes more than the oracle's newest
/// 2,000 matching attachment rows, even when the wire drains multiple pages.
pub const MAX_FILE_MENTION_RESULTS: i64 = 2_000;
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
    pub linked_path_hint: Option<String>,
    pub linked_at_ms: Option<i64>,
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
    /// Authoritative attachment hydration. This is always present, including
    /// as an empty vector, at the domain and RPC boundaries.
    pub attachments: Vec<ChatAttachment>,
}

/// The caller's authorization result for naming a linked file in a read-only
/// thread projection. Denied and unknown deliberately render identically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatProjectionFileAccess {
    Allowed(String),
    Denied,
    Unknown,
}

/// A complete read-only thread projection. Projections are never persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatThreadProjection {
    pub path: String,
    pub read_only: bool,
    pub thread_id: String,
    pub text: String,
}

/// The state of one reaction LWW cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatReactionState {
    Added,
    Removed,
}

impl ChatReactionState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Removed => "removed",
        }
    }

    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "added" => Ok(Self::Added),
            "removed" => Ok(Self::Removed),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat reaction has an unknown state",
            }),
        }
    }
}

/// One durable reaction LWW cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReaction {
    pub reaction_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub emoji: String,
    pub author_id: String,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub state: ChatReactionState,
    pub at_ms: i64,
}

/// The state of one decision LWW cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatDecisionState {
    Open,
    Resolved,
}

impl ChatDecisionState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
        }
    }

    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "open" => Ok(Self::Open),
            "resolved" => Ok(Self::Resolved),
            _ => Err(DomainError::StateCorrupt {
                reason: "chat decision has an unknown state",
            }),
        }
    }
}

/// One durable decision LWW cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatDecision {
    pub thread_id: String,
    pub message_id: String,
    pub state: ChatDecisionState,
    pub resolved_by_message_id: Option<String>,
    pub at_ms: i64,
}

/// A durable file attachment / file mention target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatAttachment {
    pub attachment_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub object_id: Option<String>,
    pub path_hint: Option<String>,
    pub heading_text: Option<String>,
    pub heading_anchor: Option<String>,
    pub heading_occurrence: Option<i64>,
    pub created_at_ms: i64,
}

/// One fully hydrated file-mention result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFileMention {
    pub attachment: ChatAttachment,
    pub message: ChatMessage,
    pub thread: ChatThread,
    pub channel: Option<ChatChannel>,
}

/// One indexed `@handle` occurrence, hydrated through its authoritative
/// message and thread at read time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMention {
    pub thread_id: String,
    pub message_id: String,
    pub handle: String,
    pub author_kind: ChatActorKind,
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

/// A channel-less file thread whose message aggregate is ahead of the human
/// read cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadFileThread {
    pub thread_id: String,
    pub message_count: i64,
    pub last_read_sequence: i64,
}

/// The agent's message-coordinate read cursor (separate from the human
/// sequence cursor above).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatAgentReadState {
    pub workspace_id: String,
    pub thread_id: String,
    pub last_read_created_at_ms: i64,
    pub last_read_message_id: String,
    pub revision: i64,
    pub updated_at_ms: i64,
}

/// An unread thread paired with the latest human-message coordinate that
/// determines its descending page order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentUnreadThreadRow {
    pub thread: ChatThread,
    pub latest_created_at_ms: i64,
    pub latest_message_id: String,
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
    pub reactions: Vec<ChatReaction>,
    pub matched_by: Vec<FollowTargetKind>,
}

/// Opening-message projection used by a channel thread summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelOpeningMessage {
    pub message_id: String,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub created_at_ms: i64,
    pub body_snippet: String,
    pub reactions: Vec<ChatReaction>,
}

/// The full aggregate consumed by desktop and MCP channel listings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelThreadSummary {
    pub thread: ChatThread,
    pub message_count: i64,
    pub last_read_sequence: i64,
    pub unread_count: i64,
    pub open_decision_count: i64,
    pub opening_message: Option<ChannelOpeningMessage>,
}

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

/// One pending-bookmark keyset row. The outbox timestamp is deliberately kept
/// beside (rather than inside) the public bookmark DTO because it is only the
/// first coordinate of the DOP1 continuation cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingBookmarkRow {
    pub bookmark: ChatBookmark,
    pub outbox_updated_at_ms: i64,
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

/// A message-to-run link in the oracle's run-first ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRecordLink {
    pub message_id: String,
    pub run: AgentRunRecord,
}

/// Receiver-private dispatch pause state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadDispatchPause {
    pub workspace_id: String,
    pub thread_id: String,
    pub paused: bool,
    pub reason: Option<String>,
    pub updated_at_ms: i64,
}

/// One ended app-quit run eligible for desktop recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRecovery {
    pub run: AgentRunRecord,
    pub attempt_count: i64,
}

/// Ascending keyset coordinate used by mention reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionCursor {
    pub created_at_ms: i64,
    pub message_id: String,
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
    pub needs_decision: bool,
    pub attachments: Vec<LocalAttachmentInput>,
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
    pub needs_decision: bool,
    pub attachments: Vec<LocalAttachmentInput>,
    pub now_ms: i64,
    /// Optional idempotency key (see [`StartChannelThread::request_id`]).
    pub request_id: Option<String>,
}

/// Caller-supplied attachment target before normalization and deterministic id
/// derivation. Optional section coordinates are an all-or-none triplet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAttachmentInput {
    pub object_id: String,
    pub path_hint: Option<String>,
    pub heading_text: Option<String>,
    pub heading_anchor: Option<String>,
    pub heading_occurrence: Option<i64>,
}

/// Inputs to [`LinkedChatStore::set_reaction`].
#[derive(Debug, Clone)]
pub struct SetReaction {
    pub workspace_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub emoji: String,
    pub author_id: String,
    pub replication_author_id: Option<String>,
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub state: ChatReactionState,
    pub now_ms: i64,
    pub request_id: String,
}

/// Inputs to [`LinkedChatStore::resolve_decision`].
#[derive(Debug, Clone)]
pub struct ResolveDecision {
    pub workspace_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub resolved_by_message_id: String,
    pub now_ms: i64,
    pub request_id: String,
}

/// Inputs to file-linked [`LinkedChatStore::create_thread`].
#[derive(Debug, Clone)]
pub struct CreateFileThread {
    pub workspace_id: String,
    pub thread_id: String,
    pub title: String,
    pub linked_object_id: String,
    pub linked_path_hint: Option<String>,
    pub now_ms: i64,
    pub request_id: String,
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

/// Stable cross-peer reaction identity derived from the reaction cell key.
pub fn reaction_id_for(message_id: &str, emoji: &str, author_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(message_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(emoji.as_bytes());
    hasher.update(b"\0");
    hasher.update(author_id.as_bytes());
    let digest = hasher.finalize();
    format!("reaction_{}", base32_lowercase_no_padding(&digest[..16]))
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
pub fn has_projection_control_char(value: &str) -> bool {
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

/// Render the TypeScript oracle's exact thread-to-Markdown projection.
pub fn render_chat_thread_projection(
    thread: &ChatThread,
    messages: &[ChatMessage],
    linked_file_access: &ChatProjectionFileAccess,
) -> Result<String, DomainError> {
    let mut lines = vec![
        format!("# {}", thread.title),
        String::new(),
        "Read-only chat projection.".to_owned(),
        String::new(),
    ];
    if thread.linked_object_id.is_some() {
        let linked_file_line = match linked_file_access {
            ChatProjectionFileAccess::Allowed(path) => {
                format!("Linked file: {}", normalize_attachment_path_hint(path)?)
            }
            ChatProjectionFileAccess::Denied | ChatProjectionFileAccess::Unknown => {
                "Linked file: unavailable".to_owned()
            }
        };
        lines.push(linked_file_line);
        lines.push(String::new());
    }
    for message in messages {
        let author = match message.author_kind {
            ChatActorKind::Human => message.author_display_name.clone(),
            ChatActorKind::Agent => format!("{} (agent)", message.author_display_name),
        };
        lines.push(format!("## {author}"));
        lines.push(String::new());
        lines.push(message.body.clone());
        lines.push(String::new());
    }
    Ok(format!(
        "{}\n",
        lines.join("\n").trim_end_matches(is_js_trim_ws)
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
fn is_bounded_replicated_chat_id(value: &str, max_utf16_units: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max_utf16_units
        && value.trim_matches(is_js_trim_ws) == value
        && !has_projection_control_char(value)
}

fn is_replicated_channel_slug(value: &str) -> bool {
    is_bounded_replicated_chat_id(value, 200)
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// Normalize a caller-minted id before it becomes a replicated chat identity.
pub fn normalize_replicated_chat_id(
    value: &str,
    reason: &'static str,
) -> Result<String, DomainError> {
    let normalized = value.trim_matches(is_js_trim_ws);
    if !is_bounded_replicated_chat_id(normalized, MAX_REPLICATED_CHAT_ID_UTF16_UNITS)
        || normalized.len() > MAX_REPLICATED_CHAT_ID_UTF8_BYTES
    {
        Err(DomainError::InvalidInput { reason })
    } else {
        Ok(normalized.to_owned())
    }
}

/// Verbatim hostile-peer reaction validation. This mirrors the oracle's one
/// regional-indicator pair or one extended-pictographic atom, optionally joined
/// to more atoms with ZWJ. It intentionally performs no NFC normalization.
pub fn is_reaction_emoji_verbatim(value: &str) -> bool {
    if value.is_empty() || value.encode_utf16().count() > MAX_REACTION_EMOJI_UTF16_UNITS {
        return false;
    }
    let chars: Vec<char> = value.chars().collect();
    let mut at = 0usize;
    if !consume_reaction_emoji_atom(&chars, &mut at) {
        return false;
    }
    while at < chars.len() {
        if chars[at] != '\u{200d}' {
            return false;
        }
        at += 1;
        if !consume_reaction_emoji_atom(&chars, &mut at) {
            return false;
        }
    }
    true
}

fn consume_reaction_emoji_atom(chars: &[char], at: &mut usize) -> bool {
    let Some(&first) = chars.get(*at) else {
        return false;
    };
    if is_regional_indicator(first) {
        let Some(&second) = chars.get(*at + 1) else {
            return false;
        };
        if !is_regional_indicator(second) {
            return false;
        }
        *at += 2;
        return true;
    }
    if !is_extended_pictographic(first) {
        return false;
    }
    *at += 1;
    while chars.get(*at).is_some_and(|ch| {
        matches!(*ch, '\u{fe0f}' | '\u{20e3}') || ('\u{1f3fb}'..='\u{1f3ff}').contains(ch)
    }) {
        *at += 1;
    }
    true
}

fn is_regional_indicator(ch: char) -> bool {
    ('\u{1f1e6}'..='\u{1f1ff}').contains(&ch)
}

fn is_extended_pictographic(ch: char) -> bool {
    let codepoint = ch as u32;
    EXTENDED_PICTOGRAPHIC_RANGES
        .binary_search_by(|(start, end)| {
            if codepoint < *start {
                std::cmp::Ordering::Greater
            } else if codepoint > *end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

// Unicode `Extended_Pictographic` ranges used by the TypeScript oracle's
// `\p{Extended_Pictographic}` regex. Kept as ranges rather than a permissive
// emoji-block approximation so hostile peers cannot smuggle non-emoji dingbats.
const EXTENDED_PICTOGRAPHIC_RANGES: &[(u32, u32)] = &[
    (0x00a9, 0x00a9),
    (0x00ae, 0x00ae),
    (0x203c, 0x203c),
    (0x2049, 0x2049),
    (0x2122, 0x2122),
    (0x2139, 0x2139),
    (0x2194, 0x2199),
    (0x21a9, 0x21aa),
    (0x231a, 0x231b),
    (0x2328, 0x2328),
    (0x23cf, 0x23cf),
    (0x23e9, 0x23f3),
    (0x23f8, 0x23fa),
    (0x24c2, 0x24c2),
    (0x25aa, 0x25ab),
    (0x25b6, 0x25b6),
    (0x25c0, 0x25c0),
    (0x25fb, 0x25fe),
    (0x2600, 0x2604),
    (0x260e, 0x260e),
    (0x2611, 0x2611),
    (0x2614, 0x2615),
    (0x2618, 0x2618),
    (0x261d, 0x261d),
    (0x2620, 0x2620),
    (0x2622, 0x2623),
    (0x2626, 0x2626),
    (0x262a, 0x262a),
    (0x262e, 0x262f),
    (0x2638, 0x263a),
    (0x2640, 0x2640),
    (0x2642, 0x2642),
    (0x2648, 0x2653),
    (0x265f, 0x2660),
    (0x2663, 0x2663),
    (0x2665, 0x2666),
    (0x2668, 0x2668),
    (0x267b, 0x267b),
    (0x267e, 0x267f),
    (0x2692, 0x2697),
    (0x2699, 0x2699),
    (0x269b, 0x269c),
    (0x26a0, 0x26a1),
    (0x26a7, 0x26a7),
    (0x26aa, 0x26ab),
    (0x26b0, 0x26b1),
    (0x26bd, 0x26be),
    (0x26c4, 0x26c5),
    (0x26c8, 0x26c8),
    (0x26ce, 0x26cf),
    (0x26d1, 0x26d1),
    (0x26d3, 0x26d4),
    (0x26e9, 0x26ea),
    (0x26f0, 0x26f5),
    (0x26f7, 0x26fa),
    (0x26fd, 0x26fd),
    (0x2702, 0x2702),
    (0x2705, 0x2705),
    (0x2708, 0x270d),
    (0x270f, 0x270f),
    (0x2712, 0x2712),
    (0x2714, 0x2714),
    (0x2716, 0x2716),
    (0x271d, 0x271d),
    (0x2721, 0x2721),
    (0x2728, 0x2728),
    (0x2733, 0x2734),
    (0x2744, 0x2744),
    (0x2747, 0x2747),
    (0x274c, 0x274c),
    (0x274e, 0x274e),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2763, 0x2764),
    (0x2795, 0x2797),
    (0x27a1, 0x27a1),
    (0x27b0, 0x27b0),
    (0x27bf, 0x27bf),
    (0x2934, 0x2935),
    (0x2b05, 0x2b07),
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
    (0x3030, 0x3030),
    (0x303d, 0x303d),
    (0x3297, 0x3297),
    (0x3299, 0x3299),
    (0x1f004, 0x1f004),
    (0x1f02c, 0x1f02f),
    (0x1f094, 0x1f09f),
    (0x1f0af, 0x1f0b0),
    (0x1f0c0, 0x1f0c0),
    (0x1f0cf, 0x1f0d0),
    (0x1f0f6, 0x1f0ff),
    (0x1f170, 0x1f171),
    (0x1f17e, 0x1f17f),
    (0x1f18e, 0x1f18e),
    (0x1f191, 0x1f19a),
    (0x1f1ae, 0x1f1e5),
    (0x1f201, 0x1f20f),
    (0x1f21a, 0x1f21a),
    (0x1f22f, 0x1f22f),
    (0x1f232, 0x1f23a),
    (0x1f23c, 0x1f23f),
    (0x1f249, 0x1f25f),
    (0x1f266, 0x1f321),
    (0x1f324, 0x1f393),
    (0x1f396, 0x1f397),
    (0x1f399, 0x1f39b),
    (0x1f39e, 0x1f3f0),
    (0x1f3f3, 0x1f3f5),
    (0x1f3f7, 0x1f3fa),
    (0x1f400, 0x1f4fd),
    (0x1f4ff, 0x1f53d),
    (0x1f549, 0x1f54e),
    (0x1f550, 0x1f567),
    (0x1f56f, 0x1f570),
    (0x1f573, 0x1f57a),
    (0x1f587, 0x1f587),
    (0x1f58a, 0x1f58d),
    (0x1f590, 0x1f590),
    (0x1f595, 0x1f596),
    (0x1f5a4, 0x1f5a5),
    (0x1f5a8, 0x1f5a8),
    (0x1f5b1, 0x1f5b2),
    (0x1f5bc, 0x1f5bc),
    (0x1f5c2, 0x1f5c4),
    (0x1f5d1, 0x1f5d3),
    (0x1f5dc, 0x1f5de),
    (0x1f5e1, 0x1f5e1),
    (0x1f5e3, 0x1f5e3),
    (0x1f5e8, 0x1f5e8),
    (0x1f5ef, 0x1f5ef),
    (0x1f5f3, 0x1f5f3),
    (0x1f5fa, 0x1f64f),
    (0x1f680, 0x1f6c5),
    (0x1f6cb, 0x1f6d2),
    (0x1f6d5, 0x1f6e5),
    (0x1f6e9, 0x1f6e9),
    (0x1f6eb, 0x1f6f0),
    (0x1f6f3, 0x1f6ff),
    (0x1f7da, 0x1f7ff),
    (0x1f80c, 0x1f80f),
    (0x1f848, 0x1f84f),
    (0x1f85a, 0x1f85f),
    (0x1f888, 0x1f88f),
    (0x1f8ae, 0x1f8af),
    (0x1f8bc, 0x1f8bf),
    (0x1f8c2, 0x1f8cf),
    (0x1f8d9, 0x1f8ff),
    (0x1f90c, 0x1f93a),
    (0x1f93c, 0x1f945),
    (0x1f947, 0x1f9ff),
    (0x1fa58, 0x1fa5f),
    (0x1fa6e, 0x1faff),
    (0x1fc00, 0x1fffd),
];

fn normalize_reaction_emoji(value: &str) -> Result<String, DomainError> {
    let normalized = nfc(value.trim_matches(is_js_trim_ws));
    if !is_reaction_emoji_verbatim(&normalized) {
        return Err(DomainError::chat(
            "invalid-message-body",
            "Reaction emoji must be a single emoji grapheme.",
        ));
    }
    Ok(normalized)
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

fn dispatch_corrupt() -> DomainError {
    DomainError::chat("state-corrupt", "Agent dispatch store is corrupt.")
}

fn persisted_nonnegative_safe(value: i64) -> bool {
    (0..=9_007_199_254_740_991).contains(&value)
}

fn persisted_safe_integer(value: i64) -> bool {
    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value)
}

/// Trim and validate an owner or target identity used by feed state.
pub fn normalize_feed_identity(value: &str, label: &str) -> Result<String, DomainError> {
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

fn opening_message_body_snippet(body: &str) -> String {
    if body.encode_utf16().count() <= OPENING_MESSAGE_BODY_SNIPPET_UTF16_UNITS {
        return body.to_owned();
    }
    let mut units = 0usize;
    let mut end = 0usize;
    for (offset, ch) in body.char_indices() {
        let width = ch.len_utf16();
        if units + width >= OPENING_MESSAGE_BODY_SNIPPET_UTF16_UNITS {
            break;
        }
        units += width;
        end = offset + ch.len_utf8();
    }
    let prefix = body[..end].trim_end_matches(is_js_trim_ws);
    format!("{prefix}\u{2026}")
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

/// Maintain the message row and an untitled thread's derived header for a
/// replicated message that was inserted in the current transaction.
pub fn index_replicated_chat_message_search_rows(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    author_display_name: &str,
    is_agent: bool,
    body: &str,
) -> Result<(), DomainError> {
    let (stored_title, first_message_id): (String, Option<String>) = conn
        .query_row(
            "SELECT title, (SELECT message_id FROM chat_messages \
               WHERE workspace_id=?1 AND thread_id=?2 \
               ORDER BY created_at_ms,message_id LIMIT 1) \
             FROM chat_threads WHERE workspace_id=?1 AND thread_id=?2",
            params![workspace_id, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(DomainError::sql_corrupt)?;
    if stored_title.is_empty() && first_message_id.as_deref() == Some(message_id) {
        let display_title = chat_thread_display_title("", Some(body));
        upsert_chat_search_index_row(
            conn,
            workspace_id,
            thread_id,
            CHAT_THREAD_HEADER_MESSAGE_ID,
            &display_title,
        )
        .map_err(DomainError::sql_persist)?;
    }
    let message_search_text = chat_message_search_text(author_display_name, is_agent, body);
    upsert_chat_search_index_row(
        conn,
        workspace_id,
        thread_id,
        message_id,
        &message_search_text,
    )
    .map_err(DomainError::sql_persist)
}

/// `normalizeChannelName`: NFC then trim, 1..=80 chars, no control chars.
/// NFC-normalize and validate a channel display name.
pub fn normalize_channel_name(name: &str) -> Result<String, DomainError> {
    let normalized = nfc(name);
    let normalized = normalized.trim_matches(is_js_trim_ws).to_owned();
    let count = normalized.encode_utf16().count();
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
        Some(t) if t.trim_matches(is_js_trim_ws).is_empty() => Ok(String::new()),
        Some(t) => {
            let normalized = t.trim_matches(is_js_trim_ws).to_owned();
            if normalized.encode_utf16().count() > MAX_THREAD_TITLE_CHARS {
                return Err(DomainError::chat(
                    "invalid-thread-title",
                    "Thread title is required.",
                ));
            }
            Ok(normalized)
        }
    }
}

/// Required-title variant used by file-linked thread creation.
fn normalize_thread_title(title: &str) -> Result<String, DomainError> {
    let normalized = title.trim_matches(is_js_trim_ws);
    if normalized.is_empty() || normalized.encode_utf16().count() > MAX_THREAD_TITLE_CHARS {
        return Err(DomainError::chat(
            "invalid-thread-title",
            "Thread title is required.",
        ));
    }
    Ok(normalized.to_owned())
}

fn normalize_attachment_object_id(object_id: &str) -> Result<String, DomainError> {
    let normalized = object_id.trim_matches(is_js_trim_ws);
    if !is_bounded_replicated_chat_id(normalized, MAX_ATTACHMENT_OBJECT_ID_UTF16_UNITS) {
        return Err(DomainError::chat(
            "invalid-path",
            "Linked file object id is invalid.",
        ));
    }
    Ok(normalized.to_owned())
}

fn normalize_attachment_path_hint(path: &str) -> Result<String, DomainError> {
    crate::validate_addressable_plaintext_path(path)
        .map_err(|_| DomainError::chat("invalid-path", "Linked file path is invalid."))
}

fn normalize_attachment_heading(
    value: &str,
    label: &'static str,
    max_utf16_units: usize,
) -> Result<String, DomainError> {
    let normalized = nfc(value);
    let normalized = normalized.trim_matches(is_js_trim_ws);
    if normalized.is_empty()
        || normalized.encode_utf16().count() > max_utf16_units
        || has_projection_control_char(normalized)
    {
        return Err(DomainError::chat("invalid-path", label));
    }
    Ok(normalized.to_owned())
}

fn normalize_attachments(
    attachments: &[LocalAttachmentInput],
) -> Result<Vec<LocalAttachmentInput>, DomainError> {
    let mut normalized = Vec::with_capacity(attachments.len());
    let mut seen = HashSet::new();
    for attachment in attachments {
        let object_id = normalize_attachment_object_id(&attachment.object_id)?;
        let path_hint = attachment
            .path_hint
            .as_deref()
            .map(normalize_attachment_path_hint)
            .transpose()?;
        let has_heading = attachment.heading_text.is_some()
            || attachment.heading_anchor.is_some()
            || attachment.heading_occurrence.is_some();
        if has_heading
            && (attachment.heading_text.is_none()
                || attachment.heading_anchor.is_none()
                || attachment.heading_occurrence.is_none())
        {
            return Err(DomainError::chat(
                "invalid-path",
                "A section mention requires heading text, anchor, and occurrence.",
            ));
        }
        let heading_text = attachment
            .heading_text
            .as_deref()
            .map(|value| {
                normalize_attachment_heading(
                    value,
                    "Heading text is invalid.",
                    MAX_ATTACHMENT_HEADING_TEXT_UTF16_UNITS,
                )
            })
            .transpose()?;
        let heading_anchor = attachment
            .heading_anchor
            .as_deref()
            .map(|value| {
                normalize_attachment_heading(
                    value,
                    "Heading anchor is invalid.",
                    MAX_ATTACHMENT_HEADING_ANCHOR_UTF16_UNITS,
                )
            })
            .transpose()?;
        let heading_occurrence = attachment.heading_occurrence;
        if heading_occurrence.is_some_and(|value| !persisted_nonnegative_safe(value)) {
            return Err(DomainError::chat(
                "invalid-path",
                "Heading occurrence is invalid.",
            ));
        }
        let target = (
            object_id.clone(),
            heading_anchor.clone(),
            heading_occurrence,
        );
        if !seen.insert(target) {
            continue;
        }
        normalized.push(LocalAttachmentInput {
            object_id,
            path_hint,
            heading_text,
            heading_anchor,
            heading_occurrence,
        });
    }
    Ok(normalized)
}

/// Deterministic attachment identity, byte-for-byte with `attachmentIdFor`.
pub fn attachment_id_for(
    message_id: &str,
    object_id: &str,
    heading_anchor: Option<&str>,
    heading_occurrence: Option<i64>,
) -> String {
    let mut hasher = Sha256::new();
    if heading_anchor.is_none() && heading_occurrence.is_none() {
        hasher.update(message_id.as_bytes());
        hasher.update(b"file");
        hasher.update(object_id.as_bytes());
    } else {
        hasher.update(message_id.as_bytes());
        hasher.update(b"\0file\0");
        hasher.update(object_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(heading_anchor.unwrap_or_default().as_bytes());
        hasher.update(b"\0");
        if let Some(occurrence) = heading_occurrence {
            hasher.update(occurrence.to_string().as_bytes());
        }
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn attachment_fingerprint_bytes(attachments: &[LocalAttachmentInput]) -> Vec<u8> {
    fn frame(out: &mut Vec<u8>, value: Option<&str>) {
        match value {
            Some(value) => {
                out.push(1);
                out.extend_from_slice(&(value.len() as u64).to_be_bytes());
                out.extend_from_slice(value.as_bytes());
            }
            None => out.push(0),
        }
    }
    let mut out = Vec::new();
    out.extend_from_slice(&(attachments.len() as u64).to_be_bytes());
    for attachment in attachments {
        frame(&mut out, Some(&attachment.object_id));
        frame(&mut out, attachment.path_hint.as_deref());
        frame(&mut out, attachment.heading_text.as_deref());
        frame(&mut out, attachment.heading_anchor.as_deref());
        frame(
            &mut out,
            attachment
                .heading_occurrence
                .as_ref()
                .map(|value| value.to_string())
                .as_deref(),
        );
    }
    out
}

/// `normalizeDisplayName`: trim, 1..=200 chars.
/// Trim and validate a chat sender display name.
pub fn normalize_display_name(display_name: &str) -> Result<String, DomainError> {
    let normalized = display_name.trim_matches(is_js_trim_ws);
    if normalized.is_empty() || normalized.encode_utf16().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(DomainError::chat(
            "invalid-sender",
            "Chat sender display name is required.",
        ));
    }
    Ok(normalized.to_owned())
}

/// `normalizeAuthorUserId`: absent -> None; else trim, 1..=200 chars.
/// Trim and validate an optional opaque relay author identity.
pub fn normalize_author_user_id(value: Option<&str>) -> Result<Option<String>, DomainError> {
    match value {
        None => Ok(None),
        Some(v) => {
            let normalized = v.trim_matches(is_js_trim_ws);
            if normalized.is_empty() || normalized.encode_utf16().count() > MAX_AUTHOR_USER_ID_CHARS
            {
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
/// Normalize line endings, trim the end, and enforce the chat body byte cap.
pub fn normalize_body(body: &str) -> Result<String, DomainError> {
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

/// Trim and validate the opaque identity used as a reaction cell key.
pub fn normalize_reaction_author_id(author_id: &str) -> Result<String, DomainError> {
    let normalized = author_id.trim_matches(is_js_trim_ws);
    if normalized.is_empty()
        || normalized.encode_utf16().count() > MAX_REACTION_AUTHOR_ID_UTF16_UNITS
    {
        return Err(DomainError::chat(
            "invalid-sender",
            "Reaction author id is invalid.",
        ));
    }
    Ok(normalized.to_owned())
}

/// The ECMAScript `String.prototype.trimEnd` whitespace set (WhiteSpace +
/// LineTerminator), so a normalized body is byte-identical to the TS
/// `normalizeBody`. It differs from Rust's `char::is_whitespace` (Unicode
/// `White_Space`) at exactly two code points: JS trims U+FEFF (ZWNBSP) which is
/// NOT `White_Space`, and JS does NOT trim U+0085 (NEL) which IS `White_Space`.
pub fn is_js_trim_ws(c: char) -> bool {
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

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            ..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn is_mention_alnum(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '\u{017F}' | '\u{212A}')
}

fn is_mention_body(ch: char) -> bool {
    is_mention_alnum(ch) || matches!(ch, '.' | '_' | '-')
}

fn normalize_mention_candidate(candidate: &str) -> Option<String> {
    if !candidate.chars().next().is_some_and(is_mention_alnum)
        || !candidate.chars().all(is_mention_body)
    {
        return None;
    }
    let candidate = candidate.trim_end_matches(['.', '_', '-']);
    if candidate.is_empty() {
        return None;
    }
    Some(candidate.nfc().flat_map(char::to_lowercase).collect())
}

fn range_contains(ranges: &[(usize, usize)], offset: usize) -> bool {
    ranges
        .iter()
        .any(|(start, end)| *start <= offset && offset < *end)
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// Candidate-agnostic mention scanner shared by local writes, imported apply,
/// and the mandatory historical backfill. This mirrors `scanMentionTokens`
/// with `ignoreCode: true`, including fenced and inline backtick suppression.
pub fn parse_mention_handles(body: &str) -> Vec<String> {
    let mut ignored = Vec::<(usize, usize)>::new();
    let mut open_fence: Option<(char, usize, usize)> = None;
    let mut line_start = 0usize;
    for line_with_newline in body.split_inclusive('\n') {
        let line = line_with_newline
            .strip_suffix('\n')
            .unwrap_or(line_with_newline);
        let content = line.strip_suffix('\r').unwrap_or(line);
        let trimmed_start = content.trim_start_matches([' ', '\t']);
        let marker_char = trimmed_start.chars().next();
        let marker_len = marker_char.map_or(0, |marker| {
            trimmed_start.chars().take_while(|ch| *ch == marker).count()
        });
        match open_fence {
            Some((marker, minimum, start))
                if marker_char == Some(marker)
                    && marker_len >= minimum
                    && js_trim(content).chars().all(|ch| ch == marker) =>
            {
                ignored.push((start, line_start + content.len()));
                open_fence = None;
            }
            None if matches!(marker_char, Some('`' | '~')) && marker_len >= 3 => {
                open_fence = Some((marker_char.expect("matched marker"), marker_len, line_start));
            }
            _ => {}
        }
        line_start += line_with_newline.len();
    }
    if let Some((_, _, start)) = open_fence {
        ignored.push((start, body.len()));
    }

    let bytes = body.as_bytes();
    let mut index = 0usize;
    let mut open: Option<(usize, usize)> = None;
    while index < bytes.len() {
        if bytes[index] != b'`' || range_contains(&ignored, index) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index] == b'`' {
            index += 1;
        }
        let run = index - start;
        match open {
            None => open = Some((run, start)),
            Some((open_run, open_start)) if run == open_run => {
                ignored.push((open_start, index));
                open = None;
            }
            Some(_) => {}
        }
    }

    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let mut handles = Vec::new();
    let mut seen = HashSet::new();
    for (position, (offset, ch)) in chars.iter().copied().enumerate() {
        if ch != '@' || range_contains(&ignored, offset) {
            continue;
        }
        if position > 0 {
            let previous = chars[position - 1].1;
            if !is_js_whitespace(previous) && !matches!(previous, '(' | '[' | '{') {
                continue;
            }
        }
        let Some((_, first)) = chars.get(position + 1).copied() else {
            continue;
        };
        if !is_mention_alnum(first) {
            continue;
        }
        let mut raw = String::new();
        for (_, candidate) in chars.iter().skip(position + 1).copied() {
            if !is_mention_body(candidate) {
                break;
            }
            raw.push(candidate);
        }
        let Some(normalized) = normalize_mention_candidate(&raw) else {
            continue;
        };
        if seen.insert(normalized.clone()) {
            handles.push(normalized);
        }
    }
    handles
}

/// Insert the complete derived mention set for one authoritative message.
/// The caller owns the surrounding message transaction.
pub fn index_message_mentions_in_tx(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    author_kind: ChatActorKind,
    body: &str,
    created_at_ms: i64,
) -> Result<usize, DomainError> {
    let mut inserted = 0usize;
    for handle in parse_mention_handles(body) {
        inserted += conn
            .execute(
                "INSERT OR IGNORE INTO chat_mentions \
                 (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    workspace_id,
                    thread_id,
                    message_id,
                    handle,
                    author_kind.as_str(),
                    created_at_ms
                ],
            )
            .map_err(DomainError::sql_persist)?;
    }
    Ok(inserted)
}

fn normalize_mention_handle(handle: &str) -> Result<String, DomainError> {
    normalize_mention_candidate(handle)
        .ok_or_else(|| DomainError::chat("invalid-message-body", "Mention handle is invalid."))
}

fn normalize_verified_user_id(value: Option<&str>) -> Result<Option<String>, DomainError> {
    match value {
        None => Ok(None),
        Some(value)
            if !value.is_empty()
                && value.encode_utf16().count() <= MAX_DISPATCH_ID_UTF16_UNITS
                && !value.contains('\0') =>
        {
            Ok(Some(value.to_owned()))
        }
        Some(_) => Err(DomainError::InvalidInput {
            reason: "verified user id is invalid",
        }),
    }
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

    fn write_with_pending_chat_replay<T>(
        &mut self,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        mutation: impl FnOnce(&Transaction<'_>) -> Result<T, DomainError>,
    ) -> Result<TxnOutcome<T>, DomainError> {
        let workspace_id = workspace_id.to_owned();
        self.store.write_with(faults, |tx| {
            let value = mutation(tx)?;
            replay_ready_pending_chat_coordinates(tx, &workspace_id)?;
            Ok(value)
        })
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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

    /// Create one file-linked thread with exactly one owner. The row, search
    /// header, relay-visible op, compatibility journal row, and request ledger
    /// commit in one actor transaction.
    pub fn create_thread(
        &mut self,
        input: &CreateFileThread,
        faults: &dyn FaultInjector,
    ) -> Result<ChatThread, DomainError> {
        non_empty(
            &input.workspace_id,
            "invalid-thread-owner",
            "workspace_id must not be empty",
        )?;
        let thread_id = normalize_replicated_chat_id(&input.thread_id, "thread id is invalid")?;
        let title = normalize_thread_title(&input.title)?;
        let object_id = normalize_attachment_object_id(&input.linked_object_id)?;
        let path_hint = input
            .linked_path_hint
            .as_deref()
            .map(normalize_attachment_path_hint)
            .transpose()?;
        if !persisted_nonnegative_safe(input.now_ms) {
            return Err(DomainError::chat(
                "invalid-message-body",
                "Thread timestamp is invalid.",
            ));
        }
        if input.request_id.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "idempotency key is required",
            });
        }
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            thread_id.as_bytes(),
            title.as_bytes(),
            object_id.as_bytes(),
            path_hint.as_deref().unwrap_or_default().as_bytes(),
        ]);
        if let Some(recorded) = self
            .store
            .read_with(|conn| lookup_request(conn, &input.request_id))?
        {
            if recorded != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self
                .store
                .read_with(|conn| require_thread(conn, &input.workspace_id, &thread_id));
        }

        let input = input.clone();
        let thread_id_c = thread_id.clone();
        let title_c = title.clone();
        let object_id_c = object_id.clone();
        let path_hint_c = path_hint.clone();
        let outcome = self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id, thread_id, title, created_at_ms, updated_at_ms, \
                  linked_object_id, linked_path_hint, linked_at_ms, channel_id) \
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?4, NULL)",
                params![
                    input.workspace_id,
                    thread_id_c,
                    title_c,
                    input.now_ms,
                    object_id_c,
                    path_hint_c
                ],
            )
            .map_err(DomainError::sql_persist)?;
            upsert_chat_search_index_row(
                tx,
                &input.workspace_id,
                &thread_id_c,
                CHAT_THREAD_HEADER_MESSAGE_ID,
                &title_c,
            )
            .map_err(DomainError::sql_persist)?;
            let mut payload = serde_json::json!({
                "threadId": thread_id_c,
                "title": title_c,
                "createdAtMs": input.now_ms,
                "linkedObjectId": object_id_c,
                "linkedAtMs": input.now_ms,
            });
            if let Some(path_hint) = &path_hint_c {
                payload
                    .as_object_mut()
                    .expect("thread payload is an object")
                    .insert("linkedPathHint".to_owned(), serde_json::json!(path_hint));
            }
            journal_local_op_in_tx(
                tx,
                &input.workspace_id,
                "chat.thread.create",
                &payload,
                input.now_ms,
            )?;
            journal(tx, &thread_id_c, "chat.thread.create", input.now_ms)?;
            record_request(tx, Some(&input.request_id), &payload_hash, input.now_ms)?;
            Ok::<_, DomainError>(ChatThread {
                workspace_id: input.workspace_id.clone(),
                thread_id: thread_id_c.clone(),
                title: title_c.clone(),
                created_at_ms: input.now_ms,
                updated_at_ms: input.now_ms,
                channel_id: None,
                linked_object_id: Some(object_id_c.clone()),
                linked_path_hint: path_hint_c.clone(),
                linked_at_ms: Some(input.now_ms),
            })
        })?;
        committed(outcome)
    }

    /// Atomically create a channel thread AND its first message in ONE
    /// transaction (`startChannelThread`). A failed send never strands an empty
    /// thread: the thread row, the message row (order 0), the read-cursor
    /// advance (for a human author), and both local journal entries commit
    /// together or not at all. A message without a verified relay author stays
    /// local and does not create relay-visible operations.
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
        let attachments = normalize_attachments(&input.attachments)?;
        let attachment_fingerprint = attachment_fingerprint_bytes(&attachments);
        let now = input.now_ms;
        if !persisted_nonnegative_safe(now) {
            return Err(DomainError::chat(
                "invalid-message-body",
                "Thread timestamp is invalid.",
            ));
        }

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
            if input.needs_decision { b"1" } else { b"0" },
            attachment_fingerprint.as_slice(),
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
        let attachments_c = attachments.clone();
        let outcome =
            self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
            let channel = require_channel(tx, &input.workspace_id, &input.channel_id)?;
            let channel_wire_id =
                wire_id_for_channel_id(tx, &input.workspace_id, &channel.channel_id)?;
            if !is_replicated_channel_slug(&channel.slug)
                || channel_wire_id
                    .as_deref()
                    .is_some_and(|wire_id| !is_bounded_replicated_chat_id(wire_id, 256))
            {
                return Err(DomainError::StateCorrupt {
                    reason: "chat channel identity cannot be replicated",
                });
            }
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
            index_message_mentions_in_tx(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                input.author_kind,
                &body_c,
                now,
            )?;
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
            let replicate = author_user_c.is_some();
            if replicate {
                ensure_thread_structure_exported(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    now,
                )?;
                journal_local_op_in_tx(
                    tx,
                    &input.workspace_id,
                    "chat.message.append",
                    &serde_json::Value::Object(message_payload.clone()),
                    now,
                )?;
            }
            if input.needs_decision {
                journal_decision_set(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    &input.message_id,
                    ChatDecisionState::Open,
                    None,
                    now,
                )?;
            }
            let message_attachments = add_local_attachments(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                &attachments_c,
                now,
                replicate,
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
                linked_path_hint: None,
                linked_at_ms: None,
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
                attachments: message_attachments,
            };
            Ok::<_, DomainError>((thread, message))
        })?;
        committed(outcome)
    }

    /// Append a message to an existing thread (`sendMessage`). A reply parent,
    /// if given, must already exist in the same thread. A message without a
    /// verified relay author stays local. A later verified message exports the
    /// thread structure before it exports that message.
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
        let attachments = normalize_attachments(&input.attachments)?;
        let attachment_fingerprint = attachment_fingerprint_bytes(&attachments);
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
            if input.needs_decision { b"1" } else { b"0" },
            attachment_fingerprint.as_slice(),
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
        let attachments_c = attachments.clone();
        let outcome =
            self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
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
            index_message_mentions_in_tx(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                input.author_kind,
                &body_c,
                now,
            )?;
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
            let replicate = author_user_c.is_some();
            let parent_is_exported = match &parent_c {
                Some(parent_message_id) if replicate => relay_log_has_authored_message(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    parent_message_id,
                )?,
                _ => false,
            };
            if let Some(parent_message_id) = &parent_c
                && parent_is_exported
            {
                payload.insert(
                    "parentMessageId".to_owned(),
                    serde_json::json!(parent_message_id),
                );
            }
            if let Some(origin) = &origin_c {
                payload.insert("origin".to_owned(), serde_json::json!(origin));
            }
            if replicate {
                ensure_thread_structure_exported(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    now,
                )?;
                journal_local_op_in_tx(
                    tx,
                    &input.workspace_id,
                    "chat.message.append",
                    &serde_json::Value::Object(payload.clone()),
                    now,
                )?;
            }
            if input.needs_decision {
                journal_decision_set(
                    tx,
                    &input.workspace_id,
                    &input.thread_id,
                    &input.message_id,
                    ChatDecisionState::Open,
                    None,
                    now,
                )?;
            }
            let message_attachments = add_local_attachments(
                tx,
                &input.workspace_id,
                &input.thread_id,
                &input.message_id,
                &attachments_c,
                now,
                replicate,
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
                attachments: message_attachments,
            })
        })?;
        committed(outcome)
    }

    /// Set one reaction LWW cell. Journal it only for a verified relay author.
    pub fn set_reaction(
        &mut self,
        input: &SetReaction,
        faults: &dyn FaultInjector,
    ) -> Result<ChatReaction, DomainError> {
        non_empty(
            &input.workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let thread_id = normalize_replicated_chat_id(&input.thread_id, "thread id is invalid")?;
        validate_message_id(&input.message_id)?;
        let emoji = normalize_reaction_emoji(&input.emoji)?;
        let author_id = normalize_reaction_author_id(&input.author_id)?;
        let replication_author_id = input
            .replication_author_id
            .as_deref()
            .map(normalize_reaction_author_id)
            .transpose()?;
        if let Some(replication_author_id) = &replication_author_id {
            if replication_author_id != &author_id {
                return Err(DomainError::chat(
                    "invalid-sender",
                    "Replication reaction author must match the local reaction author.",
                ));
            }
        }
        let author_display_name = normalize_display_name(&input.author_display_name)?;
        if input.now_ms < 0 {
            return Err(DomainError::chat(
                "invalid-message-body",
                "Reaction timestamp is invalid.",
            ));
        }
        if input.request_id.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "idempotency key is required",
            });
        }
        let payload_hash = hash_fields(&[
            thread_id.as_bytes(),
            input.message_id.as_bytes(),
            emoji.as_bytes(),
            author_id.as_bytes(),
            replication_author_id.as_deref().unwrap_or("").as_bytes(),
            input.author_kind.as_str().as_bytes(),
            author_display_name.as_bytes(),
            input.state.as_str().as_bytes(),
        ]);
        if let Some(recorded) = self
            .store
            .read_with(|conn| lookup_request(conn, &input.request_id))?
        {
            if recorded != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.store.read_with(|conn| {
                require_reaction_cell(
                    conn,
                    &input.workspace_id,
                    &input.message_id,
                    &emoji,
                    &author_id,
                )
            });
        }

        let mut input = input.clone();
        input.replication_author_id = replication_author_id;
        let outcome = self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
            require_thread(tx, &input.workspace_id, &thread_id)?;
            if !thread_has_message(tx, &input.workspace_id, &thread_id, &input.message_id)? {
                return Err(DomainError::chat(
                    "message-not-found",
                    "Reaction target was not found in this chat thread.",
                ));
            }
            let replicate = input.replication_author_id.is_some()
                && relay_log_has_authored_message(
                    tx,
                    &input.workspace_id,
                    &thread_id,
                    &input.message_id,
                )?;
            let prior_at_ms: Option<i64> = tx
                .query_row(
                    "SELECT at_ms FROM chat_reactions \
                     WHERE workspace_id = ?1 AND message_id = ?2 AND emoji = ?3 AND author_id = ?4",
                    params![input.workspace_id, input.message_id, emoji, author_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let bumped = prior_at_ms
                .map(|at_ms| {
                    at_ms.checked_add(1).ok_or(DomainError::StateCorrupt {
                        reason: "chat reaction timestamp overflowed",
                    })
                })
                .transpose()?
                .unwrap_or(i64::MIN);
            let at_ms = input.now_ms.max(bumped);
            if !persisted_safe_integer(at_ms) {
                return Err(DomainError::StateCorrupt {
                    reason: "chat reaction timestamp overflowed",
                });
            }
            let reaction_id = reaction_id_for(&input.message_id, &emoji, &author_id);
            let (origin_id, origin_seq) =
                local_replication_coordinate(tx, &input.workspace_id, at_ms)?;
            upsert_reaction_lww(
                tx,
                &input.workspace_id,
                &reaction_id,
                &thread_id,
                &input.message_id,
                &emoji,
                &author_id,
                input.author_kind,
                &author_display_name,
                input.state,
                at_ms,
                &origin_id,
                origin_seq,
            )?;
            let payload = serde_json::json!({
                "reactionId": reaction_id,
                "threadId": thread_id,
                "messageId": input.message_id,
                "emoji": emoji,
                "authorId": author_id,
                "authorKind": input.author_kind.as_str(),
                "authorDisplayName": author_display_name,
                "state": input.state.as_str(),
                "atMs": at_ms,
            });
            if replicate {
                insert_local_replication_op(
                    tx,
                    &input.workspace_id,
                    &origin_id,
                    origin_seq,
                    "chat.reaction.set",
                    &payload,
                    at_ms,
                )?;
            }
            record_request(tx, Some(&input.request_id), &payload_hash, at_ms)?;
            require_reaction_cell(
                tx,
                &input.workspace_id,
                &input.message_id,
                &emoji,
                &author_id,
            )
        })?;
        committed(outcome)
    }

    /// List active, visible reaction cells in stable `(at_ms,reaction_id)` order.
    pub fn list_reactions(
        &self,
        workspace_id: &str,
        thread_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatReaction>, DomainError> {
        if limit <= 0 || limit > MAX_MESSAGE_PAGE + 1 {
            return Err(DomainError::InvalidInput {
                reason: "reaction page limit is invalid",
            });
        }
        self.store.read_with(|conn| {
            let thread = require_thread(conn, workspace_id, thread_id)?;
            let (has_after, after_ms, after_id) = match after {
                Some((at_ms, id)) => (1, at_ms, id),
                None => (0, 0, String::new()),
            };
            let mut stmt = conn
                .prepare_cached(
                    "SELECT r.reaction_id, r.thread_id, r.message_id, r.emoji, r.author_id, \
                            r.author_kind, r.author_display_name, r.state, r.at_ms \
                     FROM chat_reactions r \
                     JOIN chat_messages m ON m.workspace_id = r.workspace_id \
                       AND m.thread_id = r.thread_id AND m.message_id = r.message_id \
                     WHERE r.workspace_id = ?1 AND r.thread_id = ?2 AND r.state = 'added' \
                       AND (?3 = 0 OR r.at_ms > ?4 OR (r.at_ms = ?4 AND r.reaction_id > ?5)) \
                     ORDER BY r.at_ms, r.reaction_id LIMIT ?6",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        thread.thread_id,
                        has_after,
                        after_ms,
                        after_id,
                        limit
                    ],
                    map_reaction_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Resolve a decision cell. An already-resolved winner is returned unchanged.
    pub fn resolve_decision(
        &mut self,
        input: &ResolveDecision,
        faults: &dyn FaultInjector,
    ) -> Result<ChatDecision, DomainError> {
        non_empty(
            &input.workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let thread_id = normalize_replicated_chat_id(&input.thread_id, "thread id is invalid")?;
        validate_message_id(&input.message_id)?;
        if input.resolved_by_message_id.is_empty() {
            return Err(DomainError::chat(
                "invalid-message-body",
                "Resolving message id is invalid.",
            ));
        }
        validate_message_id(&input.resolved_by_message_id).map_err(|_| {
            DomainError::chat("invalid-message-body", "Resolving message id is invalid.")
        })?;
        if input.now_ms < 0 {
            return Err(DomainError::chat(
                "invalid-message-body",
                "Decision timestamp is invalid.",
            ));
        }
        if input.request_id.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "idempotency key is required",
            });
        }
        let payload_hash = hash_fields(&[
            thread_id.as_bytes(),
            input.message_id.as_bytes(),
            input.resolved_by_message_id.as_bytes(),
        ]);
        if let Some(recorded) = self
            .store
            .read_with(|conn| lookup_request(conn, &input.request_id))?
        {
            if recorded != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.store.read_with(|conn| {
                require_decision(conn, &input.workspace_id, &thread_id, &input.message_id)
            });
        }

        let input = input.clone();
        let outcome = self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
            require_thread(tx, &input.workspace_id, &thread_id)?;
            let current = require_decision(tx, &input.workspace_id, &thread_id, &input.message_id)?;
            if current.state == ChatDecisionState::Resolved {
                record_request(tx, Some(&input.request_id), &payload_hash, current.at_ms)?;
                return Ok(current);
            }
            let next = current
                .at_ms
                .checked_add(1)
                .ok_or(DomainError::StateCorrupt {
                    reason: "chat decision timestamp overflowed",
                })?;
            let at_ms = input.now_ms.max(next);
            if !persisted_safe_integer(at_ms) {
                return Err(DomainError::StateCorrupt {
                    reason: "chat decision timestamp overflowed",
                });
            }
            journal_decision_set(
                tx,
                &input.workspace_id,
                &thread_id,
                &input.message_id,
                ChatDecisionState::Resolved,
                Some(&input.resolved_by_message_id),
                at_ms,
            )?;
            record_request(tx, Some(&input.request_id), &payload_hash, at_ms)?;
            require_decision(tx, &input.workspace_id, &thread_id, &input.message_id)
        })?;
        committed(outcome)
    }

    /// List visible decision cells in stable `(at_ms,message_id)` order.
    pub fn list_thread_decisions(
        &self,
        workspace_id: &str,
        thread_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatDecision>, DomainError> {
        if limit <= 0 || limit > MAX_MESSAGE_PAGE + 1 {
            return Err(DomainError::InvalidInput {
                reason: "decision page limit is invalid",
            });
        }
        self.store.read_with(|conn| {
            let thread = require_thread(conn, workspace_id, thread_id)?;
            let (has_after, after_ms, after_id) = match after {
                Some((at_ms, id)) => (1, at_ms, id),
                None => (0, 0, String::new()),
            };
            let mut stmt = conn
                .prepare_cached(
                    "SELECT d.thread_id, d.message_id, d.state, d.resolved_by_message_id, d.at_ms \
                     FROM chat_decisions d \
                     JOIN chat_messages m ON m.workspace_id = d.workspace_id \
                       AND m.thread_id = d.thread_id AND m.message_id = d.message_id \
                     WHERE d.workspace_id = ?1 AND d.thread_id = ?2 \
                       AND (?3 = 0 OR d.at_ms > ?4 OR (d.at_ms = ?4 AND d.message_id > ?5)) \
                     ORDER BY d.at_ms, d.message_id LIMIT ?6",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        thread.thread_id,
                        has_after,
                        after_ms,
                        after_id,
                        limit
                    ],
                    map_decision_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
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
                     t.channel_id, t.linked_object_id, t.linked_path_hint, t.linked_at_ms, \
                     (SELECT m.body FROM chat_messages m \
                      WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                      ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                     EXISTS(SELECT 1 FROM chat_channels c \
                       WHERE c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id) \
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

    /// Load and render a complete thread projection in oracle message order.
    pub fn get_thread_projection(
        &self,
        workspace_id: &str,
        thread_id: &str,
        linked_file_access: ChatProjectionFileAccess,
    ) -> Result<ChatThreadProjection, DomainError> {
        self.store.read_with(|conn| {
            let thread = require_thread(conn, workspace_id, thread_id)?;
            let mut stmt = conn
                .prepare_cached(
                    "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
                     author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
                     FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
                     ORDER BY created_at_ms, message_id",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, thread_id], map_message_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut messages: Vec<ChatMessage> = collect(rows)?;
            for message in &mut messages {
                hydrate_message_attachments(conn, workspace_id, message)?;
            }
            Ok(ChatThreadProjection {
                path: linked_chat_projection_path(workspace_id, &thread.thread_id, None)?,
                read_only: true,
                thread_id: thread.thread_id.clone(),
                text: render_chat_thread_projection(&thread, &messages, &linked_file_access)?,
            })
        })
    }

    /// Full per-thread aggregate for one real channel, newest activity first.
    pub fn list_channel_threads(
        &self,
        workspace_id: &str,
        channel_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChannelThreadSummary>, DomainError> {
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let (has_after, after_updated_at_ms, after_thread_id) = match after {
            Some((updated_at_ms, thread_id)) => (1_i64, updated_at_ms, thread_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let channel = require_channel(conn, workspace_id, channel_id)?;
            let threads = {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT t.workspace_id, t.thread_id, t.title, t.created_at_ms, \
                                t.updated_at_ms, t.channel_id, t.linked_object_id, \
                                t.linked_path_hint, t.linked_at_ms, \
                                (SELECT m.body FROM chat_messages m \
                                 WHERE m.workspace_id = t.workspace_id \
                                   AND m.thread_id = t.thread_id \
                                 ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                                EXISTS(SELECT 1 FROM chat_channels c \
                                  WHERE c.workspace_id = t.workspace_id \
                                    AND c.channel_id = t.channel_id) \
                         FROM chat_threads t \
                         WHERE t.workspace_id = ?1 AND t.channel_id = ?2 \
                           AND (?3 = 0 OR t.updated_at_ms < ?4 \
                             OR (t.updated_at_ms = ?4 AND t.thread_id < ?5)) \
                         ORDER BY t.updated_at_ms DESC, t.thread_id DESC LIMIT ?6",
                    )
                    .map_err(DomainError::sql_corrupt)?;
                let rows = stmt
                    .query_map(
                        params![
                            workspace_id,
                            channel.channel_id,
                            has_after,
                            after_updated_at_ms,
                            after_thread_id,
                            limit
                        ],
                        map_thread_row,
                    )
                    .map_err(DomainError::sql_corrupt)?;
                collect(rows)?
            };
            let mut summaries = Vec::with_capacity(threads.len());
            for thread in threads {
                let message_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM chat_messages \
                         WHERE workspace_id = ?1 AND thread_id = ?2",
                        params![workspace_id, thread.thread_id],
                        |row| row.get(0),
                    )
                    .map_err(DomainError::sql_corrupt)?;
                if !persisted_nonnegative_safe(message_count) {
                    return Err(DomainError::StateCorrupt {
                        reason: "channel summary message count is corrupt",
                    });
                }
                let stored_read_sequence: Option<i64> = conn
                    .query_row(
                        "SELECT last_read_sequence FROM chat_thread_read_state \
                         WHERE workspace_id = ?1 AND thread_id = ?2",
                        params![workspace_id, thread.thread_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                let stored_read_sequence = stored_read_sequence.unwrap_or(0);
                if !persisted_nonnegative_safe(stored_read_sequence) {
                    return Err(DomainError::StateCorrupt {
                        reason: "channel summary read cursor is corrupt",
                    });
                }
                let last_read_sequence = stored_read_sequence.min(message_count);
                let open_decision_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM chat_decisions d \
                         JOIN chat_messages m ON m.workspace_id = d.workspace_id \
                           AND m.thread_id = d.thread_id AND m.message_id = d.message_id \
                         WHERE d.workspace_id = ?1 AND d.thread_id = ?2 AND d.state = 'open'",
                        params![workspace_id, thread.thread_id],
                        |row| row.get(0),
                    )
                    .map_err(DomainError::sql_corrupt)?;
                if !persisted_nonnegative_safe(open_decision_count) {
                    return Err(DomainError::StateCorrupt {
                        reason: "channel summary decision count is corrupt",
                    });
                }
                let opening_message =
                    first_message_for_thread(conn, workspace_id, &thread.thread_id)?
                        .map(|message| {
                            let reactions = active_reactions_for_messages(
                                conn,
                                workspace_id,
                                std::slice::from_ref(&message.message_id),
                            )?
                            .remove(&message.message_id)
                            .unwrap_or_default();
                            Ok::<_, DomainError>(ChannelOpeningMessage {
                                message_id: message.message_id,
                                author_kind: message.author_kind,
                                author_display_name: message.author_display_name,
                                created_at_ms: message.created_at_ms,
                                body_snippet: opening_message_body_snippet(&message.body),
                                reactions,
                            })
                        })
                        .transpose()?;
                summaries.push(ChannelThreadSummary {
                    thread,
                    message_count,
                    last_read_sequence,
                    unread_count: message_count - last_read_sequence,
                    open_decision_count,
                    opening_message,
                });
            }
            Ok(summaries)
        })
    }

    /// File-linked threads by stable object identity, ordered by
    /// `(created_at_ms, thread_id)` with an exclusive keyset coordinate.
    pub fn list_threads_for_file(
        &self,
        workspace_id: &str,
        object_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatThread>, DomainError> {
        let object_id = object_id.trim_matches(is_js_trim_ws);
        if object_id.is_empty() || object_id.encode_utf16().count() > 200 {
            return Err(DomainError::chat(
                "invalid-path",
                "Linked file object id is invalid.",
            ));
        }
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let (has_after, after_created_at_ms, after_thread_id) = match after {
            Some((created_at_ms, thread_id)) => (1_i64, created_at_ms, thread_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t.workspace_id, t.thread_id, t.title, t.created_at_ms, \
                            t.updated_at_ms, t.channel_id, t.linked_object_id, \
                            t.linked_path_hint, t.linked_at_ms, \
                            (SELECT m.body FROM chat_messages m \
                             WHERE m.workspace_id = t.workspace_id \
                               AND m.thread_id = t.thread_id \
                             ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                            EXISTS(SELECT 1 FROM chat_channels c \
                              WHERE c.workspace_id = t.workspace_id \
                                AND c.channel_id = t.channel_id) \
                     FROM chat_threads t \
                     WHERE t.workspace_id = ?1 AND t.linked_object_id = ?2 \
                       AND (?3 = 0 OR t.created_at_ms > ?4 \
                         OR (t.created_at_ms = ?4 AND t.thread_id > ?5)) \
                     ORDER BY t.created_at_ms, t.thread_id LIMIT ?6",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        object_id,
                        has_after,
                        after_created_at_ms,
                        after_thread_id,
                        limit
                    ],
                    map_thread_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Point lookup used by the shared-channel write gate. Every well-formed
    /// miss, foreign-workspace thread, and file-linked thread returns `None`.
    pub fn find_thread_channel_id(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Option<String>, DomainError> {
        self.store.read_with(|conn| {
            conn.query_row(
                "SELECT channel_id FROM chat_threads \
                 WHERE workspace_id = ?1 AND thread_id = ?2",
                params![workspace_id, thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)
            .map(Option::flatten)
        })
    }

    /// Visible attachments for a present workspace thread, ordered by
    /// `(created_at_ms, attachment_id)`. The message inner join hides retained
    /// orphan attachment rows without deleting them.
    pub fn list_thread_attachments(
        &self,
        workspace_id: &str,
        thread_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatAttachment>, DomainError> {
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let (has_after, after_created_at_ms, after_attachment_id) = match after {
            Some((created_at_ms, attachment_id)) => (1_i64, created_at_ms, attachment_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            require_thread(conn, workspace_id, thread_id)?;
            let mut stmt = conn
                .prepare_cached(
                    "SELECT a.attachment_id, a.thread_id, a.message_id, a.target_kind, \
                            a.object_id, a.path_hint, a.heading_text, a.heading_anchor, \
                            a.heading_occurrence, a.created_at_ms \
                     FROM chat_attachments a JOIN chat_messages m \
                       ON m.workspace_id = a.workspace_id AND m.thread_id = a.thread_id \
                      AND m.message_id = a.message_id \
                     WHERE a.workspace_id = ?1 AND a.thread_id = ?2 \
                       AND (?3 = 0 OR a.created_at_ms > ?4 \
                         OR (a.created_at_ms = ?4 AND a.attachment_id > ?5)) \
                     ORDER BY a.created_at_ms, a.attachment_id LIMIT ?6",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        thread_id,
                        has_after,
                        after_created_at_ms,
                        after_attachment_id,
                        limit
                    ],
                    map_attachment_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Newest file mentions with object-id precedence, a complete message /
    /// thread / optional-channel hydration, and fail-closed missing entities.
    pub fn list_file_mentions(
        &self,
        workspace_id: &str,
        object_id: Option<&str>,
        path_hint: Option<&str>,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatFileMention>, DomainError> {
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let object_id = object_id.map(normalize_attachment_object_id).transpose()?;
        let path_hint = path_hint.map(normalize_attachment_path_hint).transpose()?;
        if object_id.is_none() && path_hint.is_none() {
            return Err(DomainError::chat(
                "invalid-path",
                "A file mention lookup requires an object id or path hint.",
            ));
        }
        let selector = object_id
            .as_deref()
            .or(path_hint.as_deref())
            .unwrap_or_default();
        let (has_after, after_created_at_ms, after_attachment_id) = match after {
            Some((created_at_ms, attachment_id)) => (1_i64, created_at_ms, attachment_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let predicate = if object_id.is_some() {
                "a.object_id = ?2"
            } else {
                "a.path_hint = ?2"
            };
            let sql = format!(
                "SELECT a.attachment_id, a.thread_id, a.message_id, a.target_kind, \
                        a.object_id, a.path_hint, a.heading_text, a.heading_anchor, \
                        a.heading_occurrence, a.created_at_ms \
                 FROM chat_attachments a JOIN chat_messages m \
                   ON m.workspace_id = a.workspace_id AND m.thread_id = a.thread_id \
                  AND m.message_id = a.message_id \
                 WHERE a.workspace_id = ?1 AND {predicate} \
                   AND (?3 = 0 OR a.created_at_ms < ?4 \
                     OR (a.created_at_ms = ?4 AND a.attachment_id < ?5)) \
                 ORDER BY a.created_at_ms DESC, a.attachment_id DESC LIMIT ?6"
            );
            let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        selector,
                        has_after,
                        after_created_at_ms,
                        after_attachment_id,
                        limit
                    ],
                    map_attachment_row,
                )
                .map_err(DomainError::sql_corrupt)?;
            let attachments = collect(rows)?;
            drop(stmt);
            let mut mentions = Vec::with_capacity(attachments.len());
            for attachment in attachments {
                let message = require_message(conn, workspace_id, &attachment.message_id)?;
                if message.thread_id != attachment.thread_id {
                    return Err(DomainError::StateCorrupt {
                        reason: "file mention message belongs to another thread",
                    });
                }
                let thread = require_thread(conn, workspace_id, &message.thread_id)?;
                let channel = match thread.channel_id.as_deref() {
                    Some(channel_id) => Some(require_channel(conn, workspace_id, channel_id)?),
                    None => None,
                };
                mentions.push(ChatFileMention {
                    attachment,
                    message,
                    thread,
                    channel,
                });
            }
            Ok(mentions)
        })
    }

    /// Idempotently derive missing mention rows for every authoritative
    /// message in a workspace. Workspace readiness runs this before exposing
    /// mention reads or the eligible-trigger scanner.
    pub fn backfill_mentions(
        &mut self,
        workspace_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<i64, DomainError> {
        non_empty(
            workspace_id,
            "invalid-channel-name",
            "workspace_id must not be empty",
        )?;
        let marker_id = mention_backfill_marker_id(workspace_id);
        let marker_hash = hash_fields(&[b"chat-mention-backfill-v1", workspace_id.as_bytes()]);
        let outcome = self.write_with_pending_chat_replay(workspace_id, faults, |tx| {
            let complete: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM engine_requests \
                     WHERE request_id = ?1 AND kind = 'chat-mention-backfill')",
                    params![marker_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if complete {
                return Ok::<_, DomainError>(0);
            }
            let mut stmt = tx
                .prepare(
                    "SELECT thread_id, message_id, author_kind, body, created_at_ms \
                     FROM chat_messages WHERE workspace_id = ?1 \
                     ORDER BY created_at_ms, message_id",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(DomainError::sql_corrupt)?;
            let messages: Vec<_> = rows
                .collect::<Result<_, _>>()
                .map_err(DomainError::sql_corrupt)?;
            drop(stmt);
            let mut inserted = 0usize;
            for (thread_id, message_id, author_kind, body, created_at_ms) in messages {
                let author_kind = ChatActorKind::from_db(&author_kind)?;
                inserted += index_message_mentions_in_tx(
                    tx,
                    workspace_id,
                    &thread_id,
                    &message_id,
                    author_kind,
                    &body,
                    created_at_ms,
                )?;
            }
            let inserted = i64::try_from(inserted).map_err(|_| DomainError::StateCorrupt {
                reason: "mention backfill count overflowed",
            })?;
            // This existing bookkeeping ledger is workspace-keyed through the
            // deterministic marker id. The marker commits with the final
            // derived rows, so a crash can expose neither half-completion nor
            // a false-complete scan.
            tx.execute(
                "INSERT INTO engine_requests \
                 (request_id, payload_hash, result_seq, committed_at, kind) \
                 VALUES (?1, ?2, -1, 0, 'chat-mention-backfill')",
                params![marker_id, marker_hash],
            )
            .map_err(DomainError::sql_persist)?;
            Ok(inserted)
        })?;
        committed(outcome)
    }

    /// Mention rows for a normalized handle in ascending message-coordinate
    /// order. Inner joins fail closed over missing messages or threads.
    pub fn list_mentions_for_handle(
        &self,
        workspace_id: &str,
        handle: &str,
        unread_only: bool,
        after: Option<MentionCursor>,
        limit: i64,
    ) -> Result<Vec<ChatMention>, DomainError> {
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let handle = normalize_mention_handle(handle)?;
        let (has_after, after_created_at_ms, after_message_id) = match after {
            Some(after) => (1_i64, after.created_at_ms, after.message_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT x.thread_id, x.message_id, x.handle, x.author_kind, x.created_at_ms \
                     FROM chat_mentions x \
                     JOIN chat_messages m ON m.workspace_id = x.workspace_id \
                       AND m.thread_id = x.thread_id AND m.message_id = x.message_id \
                     JOIN chat_threads t ON t.workspace_id = x.workspace_id \
                       AND t.thread_id = x.thread_id \
                     LEFT JOIN chat_agent_read_state ars ON ars.workspace_id = x.workspace_id \
                       AND ars.thread_id = x.thread_id \
                     WHERE x.workspace_id = ?1 AND x.handle = ?2 \
                       AND (?3 = 0 OR ars.thread_id IS NULL \
                         OR x.created_at_ms > ars.last_read_created_at_ms \
                         OR (x.created_at_ms = ars.last_read_created_at_ms \
                           AND x.message_id > ars.last_read_message_id)) \
                       AND (?4 = 0 OR x.created_at_ms > ?5 \
                         OR (x.created_at_ms = ?5 AND x.message_id > ?6)) \
                     ORDER BY x.created_at_ms, x.message_id LIMIT ?7",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        handle,
                        i64::from(unread_only),
                        has_after,
                        after_created_at_ms,
                        after_message_id,
                        limit
                    ],
                    |row| {
                        let thread_id: String = row.get(0)?;
                        let message_id: String = row.get(1)?;
                        let handle: String = row.get(2)?;
                        let author_kind: String = row.get(3)?;
                        let created_at_ms: i64 = row.get(4)?;
                        Ok(
                            ChatActorKind::from_db(&author_kind).map(|author_kind| ChatMention {
                                thread_id,
                                message_id,
                                handle,
                                author_kind,
                                created_at_ms,
                            }),
                        )
                    },
                )
                .map_err(DomainError::sql_corrupt)?;
            collect(rows)
        })
    }

    /// Threads whose latest message is human-authored and beyond the agent
    /// cursor, newest coordinate first.
    pub fn list_agent_unread_threads(
        &self,
        workspace_id: &str,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<AgentUnreadThreadRow>, DomainError> {
        if !(1..=501).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        let (has_after, after_created_at_ms, after_message_id) = match after {
            Some((created_at_ms, message_id)) => (1_i64, created_at_ms, message_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t.workspace_id, t.thread_id, t.title, t.created_at_ms, \
                            t.updated_at_ms, t.channel_id, t.linked_object_id, \
                            t.linked_path_hint, t.linked_at_ms, \
                            (SELECT m.body FROM chat_messages m \
                             WHERE m.workspace_id = t.workspace_id \
                               AND m.thread_id = t.thread_id \
                             ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                            EXISTS(SELECT 1 FROM chat_channels c \
                              WHERE c.workspace_id = t.workspace_id \
                                AND c.channel_id = t.channel_id), \
                            latest.created_at_ms, latest.message_id \
                     FROM chat_threads t \
                     JOIN chat_messages latest \
                       ON latest.workspace_id = t.workspace_id \
                      AND latest.thread_id = t.thread_id \
                      AND NOT EXISTS (SELECT 1 FROM chat_messages newer \
                        WHERE newer.workspace_id = latest.workspace_id \
                          AND newer.thread_id = latest.thread_id \
                          AND (newer.created_at_ms > latest.created_at_ms \
                            OR (newer.created_at_ms = latest.created_at_ms \
                              AND newer.message_id > latest.message_id))) \
                     LEFT JOIN chat_agent_read_state ars \
                       ON ars.workspace_id = t.workspace_id \
                      AND ars.thread_id = t.thread_id \
                     WHERE t.workspace_id = ?1 AND latest.author_kind = 'human' \
                       AND (ars.thread_id IS NULL \
                         OR latest.created_at_ms > ars.last_read_created_at_ms \
                         OR (latest.created_at_ms = ars.last_read_created_at_ms \
                           AND latest.message_id > ars.last_read_message_id)) \
                       AND (?2 = 0 OR latest.created_at_ms < ?3 \
                         OR (latest.created_at_ms = ?3 AND latest.message_id < ?4)) \
                     ORDER BY latest.created_at_ms DESC, latest.message_id DESC LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        has_after,
                        after_created_at_ms,
                        after_message_id,
                        limit
                    ],
                    |row| {
                        let thread = map_thread_row(row)?;
                        let latest_created_at_ms = row.get(11)?;
                        let latest_message_id = row.get(12)?;
                        Ok(thread.map(|thread| AgentUnreadThreadRow {
                            thread,
                            latest_created_at_ms,
                            latest_message_id,
                        }))
                    },
                )
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
            for message in &mut messages {
                hydrate_message_attachments(conn, workspace_id, message)?;
            }
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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

    /// Workspace-wide human unread state for channel-less, file-linked threads.
    /// This is the CLI aggregate: absent read state coalesces to zero, and any
    /// row that cannot be represented as a JavaScript safe integer fails closed.
    pub fn list_unread_file_threads(
        &self,
        workspace_id: &str,
        after_thread_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<UnreadFileThread>, DomainError> {
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

        self.store.read_with(|conn| {
            let mut statement = conn
                .prepare_cached(
                    "WITH file_threads AS ( \
                        SELECT t.thread_id, \
                            (SELECT COUNT(*) FROM chat_messages m \
                             WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id) \
                               AS message_count, \
                            COALESCE((SELECT rs.last_read_sequence FROM chat_thread_read_state rs \
                                      WHERE rs.workspace_id = t.workspace_id AND rs.thread_id = t.thread_id), 0) \
                               AS last_read_sequence \
                        FROM chat_threads t \
                        WHERE t.workspace_id = ?1 \
                          AND t.channel_id IS NULL \
                          AND t.linked_object_id IS NOT NULL \
                          AND (?2 IS NULL OR t.thread_id > ?2) \
                    ) \
                    SELECT thread_id, message_count, last_read_sequence \
                    FROM file_threads \
                    WHERE message_count > MIN(last_read_sequence, message_count) \
                       OR thread_id = '' \
                       OR message_count < 0 OR message_count > ?4 \
                       OR last_read_sequence < 0 OR last_read_sequence > ?4 \
                    ORDER BY thread_id \
                    LIMIT ?3",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = statement
                .query_map(
                    params![workspace_id, after_thread_id, limit, MAX_SAFE_INTEGER],
                    |row| {
                    Ok(UnreadFileThread {
                        thread_id: row.get(0)?,
                        message_count: row.get(1)?,
                        last_read_sequence: row.get(2)?,
                    })
                    },
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(DomainError::sql_corrupt)?;
            let mut unread = Vec::new();
            for row in rows {
                if row.thread_id.is_empty()
                    || !(0..=MAX_SAFE_INTEGER).contains(&row.message_count)
                    || !(0..=MAX_SAFE_INTEGER).contains(&row.last_read_sequence)
                {
                    return Err(DomainError::chat(
                        "state-corrupt",
                        "Chat store contains invalid read state.",
                    ));
                }
                unread.push(row);
            }
            Ok(unread)
        })
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
        // This boundary wrapper is set_follow's only pending-replay cover:
        // insert_local_replication_op and journal persist logs but do not replay.
        let outcome = self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
            validate_follow_target(tx, &input.workspace_id, input.target_kind, &input.target_id)?;
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
            let payload = serde_json::json!({
                "ownerUserId": input.owner_user_id,
                "targetKind": input.target_kind.as_str(),
                "targetId": input.target_id,
                "state": input.state.as_str(),
                "atMs": at_ms,
            });
            if input.replication_owner_user_id.is_some() {
                insert_local_replication_op(
                    tx,
                    &input.workspace_id,
                    &origin_id,
                    origin_seq,
                    "chat.follow.set",
                    &payload,
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
        committed(outcome)?;
        // Post-commit read-back is race-free only because this store holds
        // &mut EngineStore over the connection: no in-process writer can
        // interleave between the commit and this read. A second process on
        // the same file would break that assumption — fold the read into the
        // boundary-replay closure if multi-writer access ever arrives.
        self.store.read_with(|conn| {
            require_follow(
                conn,
                &input.workspace_id,
                &input.owner_user_id,
                input.target_kind,
                &input.target_id,
            )
        })
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

    /// Seed follows for every concrete non-DM channel wire identity. These
    /// receiver-private seed cells are insert-ignore and intentionally emit no
    /// replication journal entry.
    pub fn ensure_default_channel_follows(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        let workspace_id = workspace_id.to_owned();
        let owner_user_id = normalize_feed_identity(owner_user_id, "Feed owner")?;
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO chat_follows \
                 (workspace_id, owner_user_id, target_kind, target_id, state, \
                  updated_at_ms, origin_id, origin_seq) \
                 SELECT DISTINCT ?1, ?2, 'channel', w.wire_id, 'following', 0, 'seed', 0 \
                 FROM chat_channels c JOIN chat_channel_wire_ids w \
                   ON w.workspace_id = c.workspace_id AND w.channel_id = c.channel_id \
                 WHERE c.workspace_id = ?1 AND c.kind <> 'dm' \
                   AND NOT EXISTS (SELECT 1 FROM chat_channel_placeholders p \
                     WHERE p.workspace_id = c.workspace_id AND p.channel_id = c.channel_id)",
                params![workspace_id, owner_user_id],
            )
            .map_err(DomainError::sql_persist)?;
            Ok::<_, DomainError>(())
        })?;
        committed(outcome)
    }

    /// Monotonic message-coordinate CAS for the agent's read state.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_thread_read_by_agent(
        &mut self,
        workspace_id: &str,
        thread_id: &str,
        up_to_created_at_ms: i64,
        up_to_message_id: &str,
        expected_revision: Option<i64>,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatAgentReadState, DomainError> {
        if !persisted_safe_integer(up_to_created_at_ms) || up_to_message_id.is_empty() {
            return Err(DomainError::chat(
                "invalid-read-cursor",
                "Agent read cursor is invalid.",
            ));
        }
        if expected_revision.is_some_and(|revision| !persisted_nonnegative_safe(revision)) {
            return Err(DomainError::chat(
                "invalid-read-cursor",
                "Expected read-state revision is invalid.",
            ));
        }
        let workspace_id = workspace_id.to_owned();
        let thread_id = thread_id.to_owned();
        let up_to_message_id = up_to_message_id.to_owned();
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            require_thread(tx, &workspace_id, &thread_id)?;
            let current = agent_read_state_for_thread(tx, &workspace_id, &thread_id)?;
            if expected_revision.is_some_and(|revision| revision != current.revision) {
                return Err(DomainError::chat(
                    "read-state-revision-mismatch",
                    "Agent read-state revision is stale.",
                ));
            }
            let latest: Option<(i64, String)> = tx
                .query_row(
                    "SELECT created_at_ms, message_id FROM chat_messages \
                     WHERE workspace_id = ?1 AND thread_id = ?2 \
                     ORDER BY created_at_ms DESC, message_id DESC LIMIT 1",
                    params![workspace_id, thread_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some(latest) = latest else {
                return Ok::<_, DomainError>(current);
            };
            let requested = (up_to_created_at_ms, up_to_message_id.clone());
            let target = if requested > latest {
                latest
            } else {
                requested
            };
            let current_coordinate = (
                current.last_read_created_at_ms,
                current.last_read_message_id.clone(),
            );
            // Oracle parity (linkedChatStore.ts:3101-3109): no-op when the
            // clamped target is at or below the current cursor — a fresh cursor
            // is the (0, "") floor, so a negative-timestamp latest leaves the
            // thread unread-but-unmarkable exactly like the oracle (the daemon
            // does NOT advance onto a negative coordinate the oracle refuses).
            if target <= current_coordinate {
                return Ok(current);
            }
            let revision = current
                .revision
                .checked_add(1)
                .ok_or_else(dispatch_corrupt)?;
            tx.execute(
                "INSERT INTO chat_agent_read_state \
                 (workspace_id, thread_id, last_read_created_at_ms, last_read_message_id, \
                  revision, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(workspace_id, thread_id) DO UPDATE SET \
                   last_read_created_at_ms = excluded.last_read_created_at_ms, \
                   last_read_message_id = excluded.last_read_message_id, \
                   revision = excluded.revision, updated_at_ms = excluded.updated_at_ms",
                params![
                    workspace_id,
                    thread_id,
                    target.0,
                    target.1,
                    revision,
                    now_ms
                ],
            )
            .map_err(DomainError::sql_persist)?;
            Ok(ChatAgentReadState {
                workspace_id: workspace_id.clone(),
                thread_id: thread_id.clone(),
                last_read_created_at_ms: target.0,
                last_read_message_id: target.1,
                revision,
                updated_at_ms: now_ms,
            })
        })?;
        committed(outcome)
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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
            let candidate_message_ids: Vec<String> = candidates
                .iter()
                .map(|candidate| candidate.message_id.clone())
                .collect();
            let mut reactions_by_message_id =
                active_reactions_for_messages(conn, workspace_id, &candidate_message_ids)?;
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
                    reactions: reactions_by_message_id
                        .remove(&message.message_id)
                        .unwrap_or_default(),
                    message,
                    thread,
                    channel,
                    parent_message,
                    opening_message,
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
        let outcome = self.write_with_pending_chat_replay(&input.workspace_id, faults, |tx| {
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
        self.list_pending_bookmarks_page(workspace_id, owner_user_id, limit.unwrap_or(50), None)
            .map(|rows| rows.into_iter().map(|row| row.bookmark).collect())
    }

    /// Keyset page for the projection worker's poll. The exclusive coordinate
    /// is the oracle order `(outbox.updated_at_ms, bookmark_id)`.
    pub fn list_pending_bookmarks_page(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        limit: i64,
        after: Option<(i64, String)>,
    ) -> Result<Vec<PendingBookmarkRow>, DomainError> {
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        // One look-ahead row lets the wire layer distinguish a complete page
        // from a prefix without an offset or an unbounded materialization.
        if !(1..=201).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-bookmark-target",
                "Bookmark limit is invalid.",
            ));
        }
        let (has_after, after_updated_at_ms, after_bookmark_id) = match after {
            Some((updated_at_ms, bookmark_id)) => (1_i64, updated_at_ms, bookmark_id),
            None => (0_i64, 0_i64, String::new()),
        };
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(&format!(
                    "{PENDING_BOOKMARK_SELECT} \
                     WHERE b.workspace_id = ?1 AND b.owner_user_id = ?2 \
                       AND o.projection_state = 'pending' \
                       AND (?3 = 0 OR o.updated_at_ms > ?4 \
                         OR (o.updated_at_ms = ?4 AND b.bookmark_id > ?5)) \
                     ORDER BY o.updated_at_ms, b.bookmark_id LIMIT ?6"
                ))
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        owner_user_id,
                        has_after,
                        after_updated_at_ms,
                        after_bookmark_id,
                        limit
                    ],
                    |row| {
                        let bookmark = map_bookmark_row(row)?;
                        let outbox_updated_at_ms = row.get(17)?;
                        Ok(bookmark.map(|bookmark| PendingBookmarkRow {
                            bookmark,
                            outbox_updated_at_ms,
                        }))
                    },
                )
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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

    /// Queue a fresh projection generation. The request id is mandatory
    /// because semantic replay without it would increment twice.
    pub fn mark_bookmark_pending(
        &mut self,
        workspace_id: &str,
        owner_user_id: &str,
        bookmark_id: &str,
        request_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<ChatBookmark, DomainError> {
        let workspace_id = workspace_id.to_owned();
        let owner_user_id = normalize_feed_identity(owner_user_id, "Bookmark owner")?;
        let bookmark_id = normalize_feed_identity(bookmark_id, "Bookmark id")?;
        let payload_hash = hash_fields(&[
            workspace_id.as_bytes(),
            owner_user_id.as_bytes(),
            bookmark_id.as_bytes(),
        ]);
        if let Some((recorded_hash, generation)) = self
            .store
            .read_with(|conn| lookup_request_result(conn, request_id))?
        {
            if recorded_hash != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            let mut bookmark = self.store.read_with(|conn| {
                require_bookmark(conn, &workspace_id, &owner_user_id, &bookmark_id)
            })?;
            bookmark.generation = generation;
            return Ok(bookmark);
        }
        let outcome = self.write_with_pending_chat_replay(&workspace_id, faults, |tx| {
            require_bookmark(tx, &workspace_id, &owner_user_id, &bookmark_id)?;
            queue_bookmark_generation(tx, &workspace_id, &bookmark_id, now_ms)?;
            let bookmark = require_bookmark(tx, &workspace_id, &owner_user_id, &bookmark_id)?;
            record_request_result(tx, request_id, &payload_hash, bookmark.generation, now_ms)?;
            Ok::<_, DomainError>(bookmark)
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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
        let outcome = self.write_with_pending_chat_replay(&ws, faults, |tx| {
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

const PENDING_BOOKMARK_SELECT: &str = "\
SELECT b.bookmark_id, b.owner_user_id, b.target_kind, b.target_id, b.thread_id, b.message_id, \
       b.mode, b.destination_path, b.state, b.created_at_ms, b.updated_at_ms, \
       o.generation, o.projected_generation, o.projection_state, o.last_projected_at_ms, \
       o.projection_object_id, o.failure_reason, o.updated_at_ms AS outbox_updated_at_ms \
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

fn insert_attachment(
    tx: &Transaction<'_>,
    workspace_id: &str,
    attachment: &ChatAttachment,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_attachments \
         (workspace_id, attachment_id, thread_id, message_id, target_kind, object_id, \
          path_hint, heading_text, heading_anchor, heading_occurrence, created_at_ms) \
         VALUES (?1, ?2, ?3, ?4, 'file', ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            workspace_id,
            attachment.attachment_id,
            attachment.thread_id,
            attachment.message_id,
            attachment.object_id,
            attachment.path_hint,
            attachment.heading_text,
            attachment.heading_anchor,
            attachment.heading_occurrence,
            attachment.created_at_ms
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn add_local_attachments(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    attachments: &[LocalAttachmentInput],
    created_at_ms: i64,
    replicate: bool,
) -> Result<Vec<ChatAttachment>, DomainError> {
    let mut stored = Vec::with_capacity(attachments.len());
    for input in attachments {
        let attachment = ChatAttachment {
            attachment_id: attachment_id_for(
                message_id,
                &input.object_id,
                input.heading_anchor.as_deref(),
                input.heading_occurrence,
            ),
            thread_id: thread_id.to_owned(),
            message_id: message_id.to_owned(),
            object_id: Some(input.object_id.clone()),
            path_hint: input.path_hint.clone(),
            heading_text: input.heading_text.clone(),
            heading_anchor: input.heading_anchor.clone(),
            heading_occurrence: input.heading_occurrence,
            created_at_ms,
        };
        insert_attachment(tx, workspace_id, &attachment)?;
        let mut payload = serde_json::json!({
            "attachmentId": attachment.attachment_id,
            "threadId": attachment.thread_id,
            "messageId": attachment.message_id,
            "targetKind": "file",
            "objectId": attachment.object_id,
            "createdAtMs": attachment.created_at_ms,
        });
        let payload = payload
            .as_object_mut()
            .expect("attachment payload is an object");
        if let Some(path_hint) = &attachment.path_hint {
            payload.insert("pathHint".to_owned(), serde_json::json!(path_hint));
        }
        if let Some(heading_text) = &attachment.heading_text {
            payload.insert("headingText".to_owned(), serde_json::json!(heading_text));
        }
        if let Some(heading_anchor) = &attachment.heading_anchor {
            payload.insert(
                "headingAnchor".to_owned(),
                serde_json::json!(heading_anchor),
            );
        }
        if let Some(heading_occurrence) = attachment.heading_occurrence {
            payload.insert(
                "headingOccurrence".to_owned(),
                serde_json::json!(heading_occurrence),
            );
        }
        if replicate {
            journal_local_op_in_tx(
                tx,
                workspace_id,
                "chat.attachment.add",
                &serde_json::Value::Object(payload.clone()),
                created_at_ms,
            )?;
        }
        stored.push(attachment);
    }
    Ok(stored)
}

fn attachments_for_message(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<Vec<ChatAttachment>, DomainError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT attachment_id, thread_id, message_id, target_kind, object_id, path_hint, \
                    heading_text, heading_anchor, heading_occurrence, created_at_ms \
             FROM chat_attachments WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3 \
             ORDER BY created_at_ms, attachment_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, thread_id, message_id],
            map_attachment_row,
        )
        .map_err(DomainError::sql_corrupt)?;
    collect(rows)
}

fn active_reactions_for_messages(
    conn: &Connection,
    workspace_id: &str,
    message_ids: &[String],
) -> Result<HashMap<String, Vec<ChatReaction>>, DomainError> {
    let mut grouped = HashMap::new();
    if message_ids.is_empty() {
        return Ok(grouped);
    }
    let message_ids_json =
        serde_json::to_string(message_ids).map_err(|_| DomainError::StateCorrupt {
            reason: "reaction hydration id set is corrupt",
        })?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT r.reaction_id, r.thread_id, r.message_id, r.emoji, r.author_id, \
                    r.author_kind, r.author_display_name, r.state, r.at_ms \
             FROM chat_reactions r \
             JOIN chat_messages m ON m.workspace_id = r.workspace_id \
               AND m.thread_id = r.thread_id AND m.message_id = r.message_id \
             WHERE r.workspace_id = ?1 \
               AND r.message_id IN (SELECT value FROM json_each(?2)) \
               AND r.state = 'added' \
             ORDER BY r.message_id, r.at_ms, r.reaction_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, message_ids_json], map_reaction_row)
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        let reaction = row.map_err(DomainError::sql_corrupt)??;
        grouped
            .entry(reaction.message_id.clone())
            .or_insert_with(Vec::new)
            .push(reaction);
    }
    Ok(grouped)
}

fn hydrate_message_attachments(
    conn: &Connection,
    workspace_id: &str,
    message: &mut ChatMessage,
) -> Result<(), DomainError> {
    message.attachments =
        attachments_for_message(conn, workspace_id, &message.thread_id, &message.message_id)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedCoordinateResolution {
    Visible,
    Missing,
    Disallowed,
}

/// Resolve a feed coordinate separately from its receiver-private visibility.
pub fn resolve_feed_coordinate(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    created_at_ms: i64,
    message_id: &str,
) -> Result<FeedCoordinateResolution, DomainError> {
    let target: Option<(i64, Option<String>, Option<String>, bool)> = conn
        .query_row(
            "SELECT m.created_at_ms,t.channel_id,c.kind,EXISTS( \
               SELECT 1 FROM chat_channel_placeholders p \
               WHERE p.workspace_id=t.workspace_id AND p.channel_id=t.channel_id) \
             FROM chat_messages m \
             JOIN chat_threads t \
               ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
             LEFT JOIN chat_channels c \
               ON c.workspace_id=t.workspace_id AND c.channel_id=t.channel_id \
             WHERE m.workspace_id = ?1 AND m.message_id = ?2",
            params![workspace_id, message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((stored_created_at_ms, channel_id, channel_kind, placeholder)) = target else {
        return Ok(FeedCoordinateResolution::Missing);
    };
    if stored_created_at_ms != created_at_ms {
        return Ok(FeedCoordinateResolution::Disallowed);
    }
    if channel_id.is_some() && (channel_kind.is_none() || placeholder) {
        return Ok(FeedCoordinateResolution::Missing);
    }
    if channel_kind.as_deref() == Some("dm") {
        return Ok(FeedCoordinateResolution::Disallowed);
    }
    let found: Option<i64> = conn
        .query_row(
            FEED_COORDINATE_VISIBLE_SQL,
            params![workspace_id, owner_user_id, message_id, created_at_ms],
            |r| r.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(if found.is_some() {
        FeedCoordinateResolution::Visible
    } else {
        FeedCoordinateResolution::Missing
    })
}

/// Whether a `(created_at_ms, message_id)` coordinate names a message currently
/// visible to `owner_user_id` under the personal-feed predicate. Used to gate
/// `mark_feed_seen` so receiver-private state cannot skip past unseen items.
pub fn feed_coordinate_visible(
    conn: &Connection,
    workspace_id: &str,
    owner_user_id: &str,
    created_at_ms: i64,
    message_id: &str,
) -> Result<bool, DomainError> {
    Ok(
        resolve_feed_coordinate(conn, workspace_id, owner_user_id, created_at_ms, message_id)?
            == FeedCoordinateResolution::Visible,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowTargetResolution {
    Followable,
    Missing,
    Disallowed,
}

/// Resolve a follow target separately from the local DM-visibility rule.
pub fn resolve_follow_target(
    conn: &Connection,
    workspace_id: &str,
    target_kind: FollowTargetKind,
    target_id: &str,
) -> Result<FollowTargetResolution, DomainError> {
    match target_kind {
        FollowTargetKind::Channel => {
            let target: Option<(String, bool)> = conn
                .query_row(
                    "SELECT c.kind, EXISTS( \
                       SELECT 1 FROM chat_channel_placeholders p \
                       WHERE p.workspace_id = c.workspace_id AND p.channel_id = c.channel_id) \
                     FROM chat_channel_wire_ids w \
                     JOIN chat_channels c \
                       ON c.workspace_id = w.workspace_id AND c.channel_id = w.channel_id \
                     WHERE w.workspace_id = ?1 AND w.wire_id = ?2",
                    params![workspace_id, target_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            match target {
                None | Some((_, true)) => return Ok(FollowTargetResolution::Missing),
                Some((kind, false)) if kind == "dm" => {
                    return Ok(FollowTargetResolution::Disallowed);
                }
                Some(_) => {}
            }
        }
        FollowTargetKind::Thread => {
            let target: Option<(Option<String>, Option<String>, bool)> = conn
                .query_row(
                    "SELECT t.channel_id, c.kind, EXISTS( \
                       SELECT 1 FROM chat_channel_placeholders p \
                       WHERE p.workspace_id = t.workspace_id AND p.channel_id = t.channel_id) \
                     FROM chat_threads t \
                     LEFT JOIN chat_channels c \
                       ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id \
                     WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
                    params![workspace_id, target_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            match target {
                None => return Ok(FollowTargetResolution::Missing),
                Some((Some(_), None, _)) | Some((Some(_), Some(_), true)) => {
                    return Ok(FollowTargetResolution::Missing);
                }
                Some((Some(_), Some(kind), false)) if kind == "dm" => {
                    return Ok(FollowTargetResolution::Disallowed);
                }
                Some(_) => {}
            }
        }
        FollowTargetKind::Person | FollowTargetKind::Agent => {
            let author_kind = match target_kind {
                FollowTargetKind::Agent => "agent",
                FollowTargetKind::Person => "human",
                _ => unreachable!(),
            };
            let followable: i64 = conn
                .query_row(
                    "SELECT COUNT(*) \
                     FROM chat_messages m \
                     JOIN chat_threads t \
                       ON t.workspace_id = m.workspace_id AND t.thread_id = m.thread_id \
                     LEFT JOIN chat_channels c \
                       ON c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id \
                     LEFT JOIN chat_channel_placeholders p \
                       ON p.workspace_id = t.workspace_id AND p.channel_id = t.channel_id \
                     WHERE m.workspace_id = ?1 AND m.author_user_id = ?2 \
                       AND m.author_kind = ?3 \
                       AND (t.channel_id IS NULL OR \
                         (c.kind <> 'dm' AND p.channel_id IS NULL))",
                    params![workspace_id, target_id, author_kind],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if followable > 0 {
                return Ok(FollowTargetResolution::Followable);
            }
            return Ok(FollowTargetResolution::Missing);
        }
    }
    Ok(FollowTargetResolution::Followable)
}

/// Apply the local follow-target existence and DM-visibility rule.
pub fn validate_follow_target(
    conn: &Connection,
    workspace_id: &str,
    target_kind: FollowTargetKind,
    target_id: &str,
) -> Result<(), DomainError> {
    if resolve_follow_target(conn, workspace_id, target_kind, target_id)?
        != FollowTargetResolution::Followable
    {
        return Err(DomainError::chat(
            "invalid-follow-target",
            "Follow target is not followable.",
        ));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingFollowSet {
    owner_user_id: String,
    target_kind: String,
    target_id: String,
    state: String,
    at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingFeedReadSet {
    owner_user_id: String,
    last_seen_created_at_ms: i64,
    last_seen_message_id: String,
    at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAttachmentAdd {
    attachment_id: String,
    thread_id: String,
    message_id: String,
    object_id: Option<String>,
    path_hint: Option<String>,
    heading_text: Option<String>,
    heading_anchor: Option<String>,
    heading_occurrence: Option<i64>,
    created_at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingMessageAppend {
    message_id: String,
    thread_id: String,
    author_kind: String,
    author_display_name: String,
    author_user_id: Option<String>,
    parent_message_id: Option<String>,
    origin: Option<String>,
    body: String,
    created_at_ms: i64,
}

#[derive(Debug)]
struct PendingChatOperation {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PendingChatDependency {
    kind: &'static str,
    id: String,
}

enum PendingReplayOutcome {
    Applied,
    Deferred,
    Refused(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChatRefusal {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub reason: &'static str,
}

/// Replay only parked chat coordinates whose dependency was changed by one
/// authoritative local or imported mutation.
pub fn replay_pending_chat_coordinates_for_change(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
) -> Result<Vec<PendingChatRefusal>, DomainError> {
    let mut refusals = Vec::new();
    let mut dependencies = changed_chat_dependencies(tx, workspace_id, op_kind, payload)?;
    while let Some(dependency) = dependencies.pop() {
        let pending = pending_chat_operations(tx, workspace_id, &dependency)?;
        for operation in pending {
            tx.execute(
                "DELETE FROM chat_pending_replication \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace_id, operation.origin_id, operation.origin_seq],
            )
            .map_err(DomainError::sql_persist)?;
            match replay_pending_chat_operation(tx, workspace_id, &operation)? {
                PendingReplayOutcome::Applied => {
                    dependencies.extend(changed_chat_dependencies(
                        tx,
                        workspace_id,
                        &operation.op_kind,
                        &operation.payload,
                    )?);
                }
                PendingReplayOutcome::Deferred => {}
                PendingReplayOutcome::Refused(reason) => {
                    persist_pending_chat_refusal(tx, workspace_id, &operation, reason)?;
                    refusals.push(pending_chat_refusal(&operation, reason));
                }
            }
        }
    }
    Ok(refusals)
}

/// Re-evaluate every parked coordinate in one workspace against the committed
/// row state visible in the caller's transaction. Domain write boundaries use
/// this after their mutation, so non-journal writers cannot omit a wake-up.
pub fn replay_ready_pending_chat_coordinates(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<Vec<PendingChatRefusal>, DomainError> {
    let has_pending: bool = tx
        .query_row(PENDING_CHAT_WORKSPACE_EXISTS_SQL, [workspace_id], |row| {
            row.get(0)
        })
        .map_err(DomainError::sql_corrupt)?;
    if !has_pending {
        return Ok(Vec::new());
    }

    let mut refusals = Vec::new();
    loop {
        let pending = pending_chat_operations_for_workspace(tx, workspace_id)?;
        let mut applied = false;
        for operation in pending {
            match replay_pending_chat_operation(tx, workspace_id, &operation)? {
                PendingReplayOutcome::Deferred => {}
                PendingReplayOutcome::Applied => {
                    delete_pending_chat_operation(tx, workspace_id, &operation)?;
                    applied = true;
                }
                PendingReplayOutcome::Refused(reason) => {
                    persist_pending_chat_refusal(tx, workspace_id, &operation, reason)?;
                    delete_pending_chat_operation(tx, workspace_id, &operation)?;
                    refusals.push(pending_chat_refusal(&operation, reason));
                }
            }
        }
        if !applied {
            return Ok(refusals);
        }
    }
}

fn pending_chat_refusal(
    operation: &PendingChatOperation,
    reason: &'static str,
) -> PendingChatRefusal {
    PendingChatRefusal {
        origin_id: operation.origin_id.clone(),
        origin_seq: operation.origin_seq,
        op_kind: operation.op_kind.clone(),
        reason,
    }
}

fn persist_pending_chat_refusal(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
    reason: &'static str,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO replication_pending_refusals \
         (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
         VALUES (?1,?2,?3,?4,'invalid-input',?5)",
        params![
            workspace_id,
            operation.origin_id,
            operation.origin_seq,
            operation.op_kind,
            reason
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn pending_chat_operations_for_workspace(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<Vec<PendingChatOperation>, DomainError> {
    let mut stmt = tx
        .prepare(
            "SELECT log.origin_id,log.origin_seq,log.op_kind,log.payload_json \
             FROM chat_pending_replication pending \
             JOIN replication_log log \
               ON log.workspace_id=pending.workspace_id \
              AND log.origin_id=pending.origin_id \
              AND log.origin_seq=pending.origin_seq \
             WHERE pending.workspace_id=?1 \
             ORDER BY log.recorded_at_ms,log.origin_id,log.origin_seq",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?;
    let mut operations = Vec::new();
    for row in rows {
        let (origin_id, origin_seq, op_kind, payload_json) =
            row.map_err(DomainError::sql_corrupt)?;
        let payload =
            serde_json::from_str(&payload_json).map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat replication payload is corrupt",
            })?;
        operations.push(PendingChatOperation {
            origin_id,
            origin_seq,
            op_kind,
            payload,
        });
    }
    Ok(operations)
}

fn delete_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
) -> Result<(), DomainError> {
    tx.execute(
        "DELETE FROM chat_pending_replication \
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![workspace_id, operation.origin_id, operation.origin_seq],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn pending_chat_operations(
    tx: &Transaction<'_>,
    workspace_id: &str,
    dependency: &PendingChatDependency,
) -> Result<Vec<PendingChatOperation>, DomainError> {
    let mut stmt = tx
        .prepare(
            "SELECT log.origin_id,log.origin_seq,log.op_kind,log.payload_json \
             FROM chat_pending_replication pending \
             JOIN replication_log log \
               ON log.workspace_id=pending.workspace_id \
              AND log.origin_id=pending.origin_id \
              AND log.origin_seq=pending.origin_seq \
             WHERE pending.workspace_id=?1 \
               AND pending.dependency_kind=?2 AND pending.dependency_id=?3 \
             ORDER BY log.recorded_at_ms,log.origin_id,log.origin_seq",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, dependency.kind, dependency.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut operations = Vec::new();
    for row in rows {
        let (origin_id, origin_seq, op_kind, payload_json) =
            row.map_err(DomainError::sql_corrupt)?;
        let payload =
            serde_json::from_str(&payload_json).map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat replication payload is corrupt",
            })?;
        operations.push(PendingChatOperation {
            origin_id,
            origin_seq,
            op_kind,
            payload,
        });
    }
    Ok(operations)
}

fn replay_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
) -> Result<PendingReplayOutcome, DomainError> {
    match operation.op_kind.as_str() {
        "chat.follow.set" => {
            let payload: PendingFollowSet = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                    reason: "pending chat follow payload is corrupt",
                })?;
            let target_kind = match payload.target_kind.as_str() {
                "person" => FollowTargetKind::Person,
                "agent" => FollowTargetKind::Agent,
                "channel" => FollowTargetKind::Channel,
                "thread" => FollowTargetKind::Thread,
                _ => {
                    return Ok(PendingReplayOutcome::Refused(
                        "chat follow payload is invalid",
                    ));
                }
            };
            match resolve_follow_target(tx, workspace_id, target_kind, &payload.target_id)? {
                FollowTargetResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "follow-target",
                        &payload.target_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                FollowTargetResolution::Disallowed => Ok(PendingReplayOutcome::Refused(
                    "chat follow target is not followable",
                )),
                FollowTargetResolution::Followable => {
                    tx.execute(
                        "INSERT INTO chat_follows \
                         (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
                         ON CONFLICT(workspace_id,owner_user_id,target_kind,target_id) DO UPDATE SET \
                           state=excluded.state,updated_at_ms=excluded.updated_at_ms, \
                           origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
                         WHERE (excluded.updated_at_ms, excluded.state, excluded.origin_id, excluded.origin_seq) > \
                               (updated_at_ms, state, origin_id, origin_seq)",
                        params![
                            workspace_id,
                            payload.owner_user_id,
                            payload.target_kind,
                            payload.target_id,
                            payload.state,
                            payload.at_ms,
                            operation.origin_id,
                            operation.origin_seq
                        ],
                    )
                    .map_err(DomainError::sql_persist)?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.feed.read.set" => {
            let payload: PendingFeedReadSet = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                    reason: "pending chat feed-read payload is corrupt",
                })?;
            match resolve_feed_coordinate(
                tx,
                workspace_id,
                &payload.owner_user_id,
                payload.last_seen_created_at_ms,
                &payload.last_seen_message_id,
            )? {
                FeedCoordinateResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "feed-message",
                        &payload.last_seen_message_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                FeedCoordinateResolution::Disallowed => Ok(PendingReplayOutcome::Refused(
                    "chat feed read coordinate is not visible",
                )),
                FeedCoordinateResolution::Visible => {
                    tx.execute(
                        "INSERT INTO chat_feed_read_state \
                         (workspace_id,owner_user_id,last_seen_created_at_ms,last_seen_message_id,updated_at_ms,origin_id,origin_seq) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7) \
                         ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET \
                           last_seen_created_at_ms=excluded.last_seen_created_at_ms, \
                           last_seen_message_id=excluded.last_seen_message_id, \
                           updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id, \
                           origin_seq=excluded.origin_seq \
                         WHERE (excluded.last_seen_created_at_ms, excluded.last_seen_message_id, \
                                excluded.updated_at_ms, excluded.origin_id, excluded.origin_seq) > \
                               (last_seen_created_at_ms, last_seen_message_id, updated_at_ms, \
                                origin_id, origin_seq)",
                        params![
                            workspace_id,
                            payload.owner_user_id,
                            payload.last_seen_created_at_ms,
                            payload.last_seen_message_id,
                            payload.at_ms,
                            operation.origin_id,
                            operation.origin_seq
                        ],
                    )
                    .map_err(DomainError::sql_persist)?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.attachment.add" => {
            let payload: PendingAttachmentAdd = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat attachment payload is corrupt",
            })?;
            match resolve_thread_message(tx, workspace_id, &payload.thread_id, &payload.message_id)?
            {
                ThreadMessageResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "attachment-message",
                        &payload.message_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                ThreadMessageResolution::DifferentThread => Ok(PendingReplayOutcome::Refused(
                    "chat attachment target message belongs to another thread",
                )),
                ThreadMessageResolution::Present => {
                    tx.execute(
                        "INSERT OR IGNORE INTO chat_attachments \
                         (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id, \
                          path_hint,heading_text,heading_anchor,heading_occurrence,created_at_ms) \
                         VALUES (?1,?2,?3,?4,'file',?5,?6,?7,?8,?9,?10)",
                        params![
                            workspace_id,
                            payload.attachment_id,
                            payload.thread_id,
                            payload.message_id,
                            payload.object_id,
                            payload.path_hint,
                            payload.heading_text,
                            payload.heading_anchor,
                            payload.heading_occurrence,
                            payload.created_at_ms
                        ],
                    )
                    .map_err(DomainError::sql_persist)?;
                    mark_live_bookmarks_pending(
                        tx,
                        workspace_id,
                        &payload.thread_id,
                        payload.created_at_ms,
                    )?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.message.append" => {
            let payload: PendingMessageAppend = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat message payload is corrupt",
            })?;
            let thread_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_threads \
                     WHERE workspace_id=?1 AND thread_id=?2)",
                    params![workspace_id, payload.thread_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if !thread_exists {
                park_pending_chat_operation(
                    tx,
                    workspace_id,
                    operation,
                    "message-thread",
                    &payload.thread_id,
                )?;
                return Ok(PendingReplayOutcome::Deferred);
            }
            apply_pending_message(tx, workspace_id, payload)?;
            Ok(PendingReplayOutcome::Applied)
        }
        _ => Ok(PendingReplayOutcome::Refused(
            "pending chat operation kind is invalid",
        )),
    }
}

fn apply_pending_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: PendingMessageAppend,
) -> Result<(), DomainError> {
    let author_display_name =
        normalize_display_name(&payload.author_display_name).map_err(|_| {
            DomainError::StateCorrupt {
                reason: "pending chat message display name is invalid",
            }
        })?;
    let author_user_id =
        normalize_author_user_id(payload.author_user_id.as_deref()).map_err(|_| {
            DomainError::StateCorrupt {
                reason: "pending chat message author id is invalid",
            }
        })?;
    if author_user_id != payload.author_user_id {
        return Err(DomainError::StateCorrupt {
            reason: "pending chat message author id changed during replay",
        });
    }
    let body = normalize_body(&payload.body).map_err(|_| DomainError::StateCorrupt {
        reason: "pending chat message body is invalid",
    })?;
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(message_order), -1) FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2",
            params![workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    let order = previous.checked_add(1).ok_or(DomainError::StateCorrupt {
        reason: "pending chat message order overflowed",
    })?;
    let parent_exists = if let Some(parent) = &payload.parent_message_id {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2 AND message_id=?3)",
            params![workspace_id, payload.thread_id, parent],
            |row| row.get::<_, bool>(0),
        )
        .map_err(DomainError::sql_corrupt)?
    } else {
        false
    };
    let stored_parent = if parent_exists {
        payload.parent_message_id.as_deref()
    } else {
        None
    };
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO chat_messages \
             (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name, \
              author_user_id,parent_message_id,origin,body,created_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                workspace_id,
                payload.thread_id,
                order,
                payload.message_id,
                payload.author_kind,
                author_display_name,
                author_user_id,
                stored_parent,
                payload.origin,
                body,
                payload.created_at_ms
            ],
        )
        .map_err(DomainError::sql_persist)?;
    if inserted == 0 {
        return Ok(());
    }
    for handle in parse_mention_handles(&body) {
        tx.execute(
            "INSERT OR IGNORE INTO chat_mentions \
             (workspace_id,thread_id,message_id,handle,author_kind,created_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                workspace_id,
                payload.thread_id,
                payload.message_id,
                handle,
                payload.author_kind,
                payload.created_at_ms
            ],
        )
        .map_err(DomainError::sql_persist)?;
    }
    if let Some(parent) = payload
        .parent_message_id
        .as_deref()
        .filter(|_| !parent_exists)
        && parent != payload.message_id
    {
        tx.execute(
            "INSERT OR IGNORE INTO chat_pending_message_parents \
             (workspace_id,child_message_id,thread_id,parent_message_id) \
             VALUES (?1,?2,?3,?4)",
            params![workspace_id, payload.message_id, payload.thread_id, parent],
        )
        .map_err(DomainError::sql_persist)?;
    }
    tx.execute(
        "UPDATE chat_messages SET parent_message_id=?3 \
         WHERE workspace_id=?1 AND thread_id=?2 AND message_id IN (\
           SELECT child_message_id FROM chat_pending_message_parents \
           WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3)",
        params![workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM chat_pending_message_parents \
         WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3",
        params![workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "UPDATE chat_threads SET updated_at_ms=MAX(updated_at_ms,?3) \
         WHERE workspace_id=?1 AND thread_id=?2",
        params![workspace_id, payload.thread_id, payload.created_at_ms],
    )
    .map_err(DomainError::sql_persist)?;
    mark_live_bookmarks_pending(tx, workspace_id, &payload.thread_id, payload.created_at_ms)?;
    index_replicated_chat_message_search_rows(
        tx,
        workspace_id,
        &payload.thread_id,
        &payload.message_id,
        &author_display_name,
        payload.author_kind == "agent",
        &body,
    )?;
    Ok(())
}

fn park_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
    dependency_kind: &'static str,
    dependency_id: &str,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_pending_replication \
         (workspace_id,origin_id,origin_seq,dependency_kind,dependency_id) \
         VALUES (?1,?2,?3,?4,?5)",
        params![
            workspace_id,
            operation.origin_id,
            operation.origin_seq,
            dependency_kind,
            dependency_id
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn changed_chat_dependencies(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
) -> Result<Vec<PendingChatDependency>, DomainError> {
    let mut dependencies = Vec::new();
    match op_kind {
        "chat.channel.create" => {
            let wire_id = payload
                .get("wireId")
                .and_then(serde_json::Value::as_str)
                .or_else(|| payload.get("channelId").and_then(serde_json::Value::as_str));
            let Some(wire_id) = wire_id else {
                return Ok(dependencies);
            };
            dependencies.push(PendingChatDependency {
                kind: "follow-target",
                id: wire_id.to_owned(),
            });
            let channel_id: Option<String> = tx
                .query_row(
                    "SELECT channel_id FROM chat_channel_wire_ids \
                     WHERE workspace_id=?1 AND wire_id=?2",
                    params![workspace_id, wire_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if let Some(channel_id) = channel_id {
                collect_dependency_ids(
                    tx,
                    "SELECT thread_id FROM chat_threads \
                     WHERE workspace_id=?1 AND channel_id=?2",
                    workspace_id,
                    &channel_id,
                    "follow-target",
                    &mut dependencies,
                )?;
                collect_dependency_ids(
                    tx,
                    "SELECT DISTINCT m.author_user_id FROM chat_messages m \
                     JOIN chat_threads t \
                       ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
                     WHERE m.workspace_id=?1 AND t.channel_id=?2 \
                       AND m.author_user_id IS NOT NULL",
                    workspace_id,
                    &channel_id,
                    "follow-target",
                    &mut dependencies,
                )?;
                collect_dependency_ids(
                    tx,
                    "SELECT m.message_id FROM chat_messages m \
                     JOIN chat_threads t \
                       ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
                     WHERE m.workspace_id=?1 AND t.channel_id=?2",
                    workspace_id,
                    &channel_id,
                    "feed-message",
                    &mut dependencies,
                )?;
            }
        }
        "chat.thread.create" => {
            if let Some(thread_id) = payload.get("threadId").and_then(serde_json::Value::as_str) {
                for kind in ["follow-target", "message-thread"] {
                    dependencies.push(PendingChatDependency {
                        kind,
                        id: thread_id.to_owned(),
                    });
                }
            }
        }
        "chat.message.append" => {
            if let Some(message_id) = payload.get("messageId").and_then(serde_json::Value::as_str) {
                for kind in ["feed-message", "attachment-message"] {
                    dependencies.push(PendingChatDependency {
                        kind,
                        id: message_id.to_owned(),
                    });
                }
            }
            if let Some(author_user_id) = payload
                .get("authorUserId")
                .and_then(serde_json::Value::as_str)
            {
                dependencies.push(PendingChatDependency {
                    kind: "follow-target",
                    id: author_user_id.to_owned(),
                });
            }
        }
        "chat.follow.set" => {
            let payload: PendingFollowSet = match serde_json::from_value(payload.clone()) {
                Ok(payload) => payload,
                Err(_) => return Ok(dependencies),
            };
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM chat_follows \
                     WHERE workspace_id=?1 AND owner_user_id=?2 \
                       AND target_kind=?3 AND target_id=?4",
                    params![
                        workspace_id,
                        payload.owner_user_id,
                        payload.target_kind,
                        payload.target_id
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if state.as_deref() == Some("following") {
                collect_feed_dependencies_for_follow(
                    tx,
                    workspace_id,
                    &payload,
                    &mut dependencies,
                )?;
            }
        }
        _ => {}
    }
    Ok(dependencies)
}

fn collect_dependency_ids(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
    changed_id: &str,
    dependency_kind: &'static str,
    dependencies: &mut Vec<PendingChatDependency>,
) -> Result<(), DomainError> {
    let mut stmt = tx.prepare(sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, changed_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        dependencies.push(PendingChatDependency {
            kind: dependency_kind,
            id: row.map_err(DomainError::sql_corrupt)?,
        });
    }
    Ok(())
}

fn collect_feed_dependencies_for_follow(
    tx: &Transaction<'_>,
    workspace_id: &str,
    follow: &PendingFollowSet,
    dependencies: &mut Vec<PendingChatDependency>,
) -> Result<(), DomainError> {
    let target_clause = match follow.target_kind.as_str() {
        "person" => "m.author_kind='human' AND m.author_user_id=?3",
        "agent" => "m.author_kind='agent' AND m.author_user_id=?3",
        "thread" => "m.thread_id=?3",
        "channel" => {
            "EXISTS (SELECT 1 FROM chat_channel_wire_ids w \
               WHERE w.workspace_id=m.workspace_id AND w.channel_id=t.channel_id AND w.wire_id=?3) \
             AND m.message_id=(SELECT first.message_id FROM chat_messages first \
               WHERE first.workspace_id=m.workspace_id AND first.thread_id=m.thread_id \
               ORDER BY first.created_at_ms,first.message_id LIMIT 1)"
        }
        _ => return Ok(()),
    };
    let sql = format!(
        "SELECT pending.dependency_id \
         FROM chat_pending_replication pending \
         JOIN replication_log log \
           ON log.workspace_id=pending.workspace_id \
          AND log.origin_id=pending.origin_id AND log.origin_seq=pending.origin_seq \
         JOIN chat_messages m \
           ON m.workspace_id=pending.workspace_id AND m.message_id=pending.dependency_id \
         JOIN chat_threads t \
           ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
         WHERE pending.workspace_id=?1 AND pending.dependency_kind='feed-message' \
           AND json_extract(log.payload_json,'$.ownerUserId')=?2 AND {target_clause}"
    );
    let mut stmt = tx.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, follow.owner_user_id, follow.target_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        dependencies.push(PendingChatDependency {
            kind: "feed-message",
            id: row.map_err(DomainError::sql_corrupt)?,
        });
    }
    Ok(())
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
         t.channel_id, t.linked_object_id, t.linked_path_hint, t.linked_at_ms, \
         (SELECT m.body FROM chat_messages m \
          WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
          ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
         EXISTS(SELECT 1 FROM chat_channels c \
           WHERE c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id) \
         FROM chat_threads t WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
        params![workspace_id, thread_id],
        map_thread_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("thread-not-found", "Chat thread was not found."))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadMessageResolution {
    Present,
    Missing,
    DifferentThread,
}

/// Resolve a workspace-scoped message separately from its thread ownership.
pub fn resolve_thread_message(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<ThreadMessageResolution, DomainError> {
    let found_thread_id: Option<String> = conn
        .query_row(
            "SELECT thread_id FROM chat_messages \
             WHERE workspace_id = ?1 AND message_id = ?2",
            params![workspace_id, message_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(match found_thread_id {
        None => ThreadMessageResolution::Missing,
        Some(found_thread_id) if found_thread_id == thread_id => ThreadMessageResolution::Present,
        Some(_) => ThreadMessageResolution::DifferentThread,
    })
}

/// Whether a message belongs to the named workspace-scoped chat thread.
pub fn thread_has_message(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<bool, DomainError> {
    Ok(
        resolve_thread_message(conn, workspace_id, thread_id, message_id)?
            == ThreadMessageResolution::Present,
    )
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

#[allow(clippy::too_many_arguments)]
fn upsert_reaction_lww(
    tx: &Transaction<'_>,
    workspace_id: &str,
    reaction_id: &str,
    thread_id: &str,
    message_id: &str,
    emoji: &str,
    author_id: &str,
    author_kind: ChatActorKind,
    author_display_name: &str,
    state: ChatReactionState,
    at_ms: i64,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO chat_reactions \
         (workspace_id,reaction_id,thread_id,message_id,emoji,author_id,author_kind,\
          author_display_name,state,at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
         ON CONFLICT(workspace_id,message_id,emoji,author_id) DO UPDATE SET \
           reaction_id=excluded.reaction_id,thread_id=excluded.thread_id,\
           author_kind=excluded.author_kind,author_display_name=excluded.author_display_name,\
           state=excluded.state,at_ms=excluded.at_ms,origin_id=excluded.origin_id,\
           origin_seq=excluded.origin_seq \
         WHERE excluded.at_ms > chat_reactions.at_ms \
            OR (excluded.at_ms = chat_reactions.at_ms AND \
                (excluded.state > chat_reactions.state OR \
                 (excluded.state = chat_reactions.state AND \
                  (excluded.origin_id > chat_reactions.origin_id OR \
                   (excluded.origin_id = chat_reactions.origin_id AND \
                    excluded.origin_seq > chat_reactions.origin_seq)))))",
        params![
            workspace_id,
            reaction_id,
            thread_id,
            message_id,
            emoji,
            author_id,
            author_kind.as_str(),
            author_display_name,
            state.as_str(),
            at_ms,
            origin_id,
            origin_seq
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_decision_lww(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    state: ChatDecisionState,
    resolved_by_message_id: Option<&str>,
    at_ms: i64,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO chat_decisions \
         (workspace_id,thread_id,message_id,state,resolved_by_message_id,at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
         ON CONFLICT(workspace_id,message_id) DO UPDATE SET \
           thread_id=excluded.thread_id,state=excluded.state,\
           resolved_by_message_id=excluded.resolved_by_message_id,at_ms=excluded.at_ms,\
           origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE excluded.at_ms > chat_decisions.at_ms \
            OR (excluded.at_ms = chat_decisions.at_ms AND \
                (CASE excluded.state WHEN 'resolved' THEN 1 ELSE 0 END) > \
                (CASE chat_decisions.state WHEN 'resolved' THEN 1 ELSE 0 END)) \
            OR (excluded.at_ms = chat_decisions.at_ms \
                AND excluded.state = chat_decisions.state \
                AND (excluded.origin_id > chat_decisions.origin_id OR \
                     (excluded.origin_id = chat_decisions.origin_id \
                      AND excluded.origin_seq > chat_decisions.origin_seq)))",
        params![
            workspace_id,
            thread_id,
            message_id,
            state.as_str(),
            resolved_by_message_id,
            at_ms,
            origin_id,
            origin_seq
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn journal_decision_set(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    state: ChatDecisionState,
    resolved_by_message_id: Option<&str>,
    at_ms: i64,
) -> Result<(), DomainError> {
    let (origin_id, origin_seq) = local_replication_coordinate(tx, workspace_id, at_ms)?;
    upsert_decision_lww(
        tx,
        workspace_id,
        thread_id,
        message_id,
        state,
        resolved_by_message_id,
        at_ms,
        &origin_id,
        origin_seq,
    )?;
    let mut payload = serde_json::json!({
        "threadId": thread_id,
        "messageId": message_id,
        "state": state.as_str(),
        "atMs": at_ms,
    });
    if let Some(resolver) = resolved_by_message_id {
        payload
            .as_object_mut()
            .expect("decision payload is an object")
            .insert(
                "resolvedByMessageId".to_owned(),
                serde_json::json!(resolver),
            );
    }
    if relay_log_has_authored_message(tx, workspace_id, thread_id, message_id)? {
        insert_local_replication_op(
            tx,
            workspace_id,
            &origin_id,
            origin_seq,
            "chat.decision.set",
            &payload,
            at_ms,
        )?;
    }
    Ok(())
}

fn relay_log_has_entity(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    json_path: &str,
    entity_id: &str,
) -> Result<bool, DomainError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replication_log \
         WHERE workspace_id = ?1 AND op_kind = ?2 \
           AND json_extract(payload_json, ?3) = ?4)",
        params![workspace_id, op_kind, json_path, entity_id],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

fn relay_log_has_authored_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<bool, DomainError> {
    // Terminally refused imports remain in replication_log without a projection.
    // Bind the log row to the current authored message before exporting derived state.
    tx.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM chat_messages AS message \
           JOIN replication_log AS operation \
             ON operation.workspace_id = message.workspace_id \
            AND operation.op_kind = 'chat.message.append' \
            AND json_extract(operation.payload_json, '$.threadId') = message.thread_id \
            AND json_extract(operation.payload_json, '$.messageId') = message.message_id \
            AND json_extract(operation.payload_json, '$.authorUserId') = message.author_user_id \
           WHERE message.workspace_id = ?1 \
             AND message.thread_id = ?2 \
             AND message.message_id = ?3 \
             AND message.author_user_id IS NOT NULL)",
        params![workspace_id, thread_id, message_id],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

fn ensure_thread_structure_exported(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    recorded_at_ms: i64,
) -> Result<(), DomainError> {
    if relay_log_has_entity(
        tx,
        workspace_id,
        "chat.thread.create",
        "$.threadId",
        thread_id,
    )? {
        return Ok(());
    }

    let (title, created_at_ms, channel_id, linked_object_id, linked_path_hint, linked_at_ms): (
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    ) = tx
        .query_row(
            "SELECT title, created_at_ms, channel_id, linked_object_id, \
                    linked_path_hint, linked_at_ms \
             FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(DomainError::sql_corrupt)?;

    let mut payload = serde_json::json!({
        "threadId": thread_id,
        "title": title,
        "createdAtMs": created_at_ms,
    });
    let payload_object = payload
        .as_object_mut()
        .expect("thread payload is an object");
    if let Some(channel_id) = channel_id {
        let channel = require_channel(tx, workspace_id, &channel_id)?;
        let channel_wire_id = wire_id_for_channel_id(tx, workspace_id, &channel_id)?;
        if !is_replicated_channel_slug(&channel.slug)
            || channel_wire_id
                .as_deref()
                .is_some_and(|wire_id| !is_bounded_replicated_chat_id(wire_id, 256))
        {
            return Err(DomainError::StateCorrupt {
                reason: "chat channel identity cannot be replicated",
            });
        }
        payload_object.insert("channelSlug".to_owned(), serde_json::json!(channel.slug));
        if let Some(channel_wire_id) = channel_wire_id {
            payload_object.insert(
                "channelWireId".to_owned(),
                serde_json::json!(channel_wire_id),
            );
        }
    } else {
        let linked_object_id = linked_object_id.ok_or(DomainError::StateCorrupt {
            reason: "chat thread has no replication owner",
        })?;
        let linked_at_ms = linked_at_ms.ok_or(DomainError::StateCorrupt {
            reason: "chat thread has no replication timestamp",
        })?;
        payload_object.insert(
            "linkedObjectId".to_owned(),
            serde_json::json!(linked_object_id),
        );
        payload_object.insert("linkedAtMs".to_owned(), serde_json::json!(linked_at_ms));
        if let Some(linked_path_hint) = linked_path_hint {
            payload_object.insert(
                "linkedPathHint".to_owned(),
                serde_json::json!(linked_path_hint),
            );
        }
    }
    journal_local_op_in_tx(
        tx,
        workspace_id,
        "chat.thread.create",
        &payload,
        recorded_at_ms,
    )
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
    )?;
    replay_pending_chat_coordinates_for_change(tx, workspace_id, op_kind, payload).map(|_| ())
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
    let mut message = conn
        .query_row(
            "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND message_id = ?2",
            params![workspace_id, message_id],
            map_message_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .transpose()?
        .ok_or_else(|| DomainError::chat("message-not-found", "Chat message was not found."))?;
    hydrate_message_attachments(conn, workspace_id, &mut message)?;
    Ok(message)
}

fn require_reaction_cell(
    conn: &Connection,
    workspace_id: &str,
    message_id: &str,
    emoji: &str,
    author_id: &str,
) -> Result<ChatReaction, DomainError> {
    conn.query_row(
        "SELECT reaction_id, thread_id, message_id, emoji, author_id, author_kind, \
                author_display_name, state, at_ms \
         FROM chat_reactions WHERE workspace_id = ?1 AND message_id = ?2 \
           AND emoji = ?3 AND author_id = ?4",
        params![workspace_id, message_id, emoji, author_id],
        map_reaction_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or(DomainError::StateCorrupt {
        reason: "reaction upsert left no row",
    })
}

fn require_decision(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<ChatDecision, DomainError> {
    conn.query_row(
        "SELECT thread_id, message_id, state, resolved_by_message_id, at_ms \
         FROM chat_decisions WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
        params![workspace_id, thread_id, message_id],
        map_decision_row,
    )
    .optional()
    .map_err(DomainError::sql_corrupt)?
    .transpose()?
    .ok_or_else(|| DomainError::chat("decision-not-found", "Chat decision was not found."))
}

fn agent_read_state_for_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ChatAgentReadState, DomainError> {
    let row = conn
        .query_row(
            "SELECT last_read_created_at_ms, last_read_message_id, revision, updated_at_ms \
             FROM chat_agent_read_state WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((created_at_ms, message_id, revision, updated_at_ms)) = row else {
        return Ok(ChatAgentReadState {
            workspace_id: workspace_id.to_owned(),
            thread_id: thread_id.to_owned(),
            last_read_created_at_ms: 0,
            last_read_message_id: String::new(),
            revision: 0,
            updated_at_ms: 0,
        });
    };
    if !persisted_safe_integer(created_at_ms)
        || !persisted_nonnegative_safe(revision)
        || !persisted_nonnegative_safe(updated_at_ms)
    {
        return Err(dispatch_corrupt());
    }
    Ok(ChatAgentReadState {
        workspace_id: workspace_id.to_owned(),
        thread_id: thread_id.to_owned(),
        last_read_created_at_ms: created_at_ms,
        last_read_message_id: message_id,
        revision,
        updated_at_ms,
    })
}

fn message_by_id(
    conn: &Connection,
    workspace_id: &str,
    message_id: &str,
) -> Result<Option<ChatMessage>, DomainError> {
    let mut message = conn
        .query_row(
            "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND message_id = ?2",
            params![workspace_id, message_id],
            map_message_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .transpose()?;
    if let Some(message) = &mut message {
        hydrate_message_attachments(conn, workspace_id, message)?;
    }
    Ok(message)
}

fn first_message_for_thread(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<Option<ChatMessage>, DomainError> {
    let mut message = conn
        .query_row(
            "SELECT workspace_id, thread_id, message_order, message_id, author_kind, \
         author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
         ORDER BY created_at_ms, message_id LIMIT 1",
            params![workspace_id, thread_id],
            map_message_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .transpose()?;
    if let Some(message) = &mut message {
        hydrate_message_attachments(conn, workspace_id, message)?;
    }
    Ok(message)
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

fn lookup_request_result(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<(String, i64)>, DomainError> {
    conn.query_row(
        "SELECT payload_hash, result_seq FROM engine_requests WHERE request_id = ?1",
        params![request_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn record_request_result(
    tx: &Transaction<'_>,
    request_id: &str,
    payload_hash: &str,
    result_seq: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO engine_requests \
         (request_id, payload_hash, result_seq, committed_at, kind) \
         VALUES (?1, ?2, ?3, ?4, 'chat')",
        params![request_id, payload_hash, result_seq, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
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
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, -1, ?3, 'chat')",
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

fn mention_backfill_marker_id(workspace_id: &str) -> String {
    format!(
        "dohc:chat-mention-backfill:{}",
        hash_fields(&[workspace_id.as_bytes()])
    )
}

// -------------------------------------------------------------------- mappers

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
    let first_body: Option<String> = row.get(9)?;
    let mut channel_id: Option<String> = row.get(5)?;
    let mut linked_object_id: Option<String> = row.get(6)?;
    let mut linked_path_hint: Option<String> = row.get(7)?;
    let mut linked_at_ms: Option<i64> = row.get(8)?;
    let channel_owner_exists: i64 = row.get(10)?;
    let created_at_ms: i64 = row.get(3)?;
    let updated_at_ms: i64 = row.get(4)?;
    let has_linked_owner = linked_object_id
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let has_channel_owner = channel_id.as_deref().is_some_and(|value| !value.is_empty());
    if has_linked_owner == has_channel_owner
        || has_channel_owner && channel_owner_exists != 1
        || has_linked_owner && linked_at_ms.is_none()
        || !persisted_safe_integer(created_at_ms)
        || !persisted_safe_integer(updated_at_ms)
        || has_linked_owner && linked_at_ms.is_some_and(|value| !persisted_safe_integer(value))
    {
        return Ok(Err(DomainError::chat(
            "state-corrupt",
            "Chat thread ownership is corrupt.",
        )));
    }
    if !has_linked_owner {
        linked_object_id = None;
        linked_path_hint = None;
        linked_at_ms = None;
    }
    if !has_channel_owner {
        channel_id = None;
    }
    Ok(Ok(ChatThread {
        workspace_id: row.get(0)?,
        thread_id: row.get(1)?,
        title: chat_thread_display_title(&stored_title, first_body.as_deref()),
        created_at_ms,
        updated_at_ms,
        channel_id,
        linked_object_id,
        linked_path_hint,
        linked_at_ms,
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
            attachments: Vec::new(),
        }),
    )
}

fn map_reaction_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ChatReaction, DomainError>> {
    let reaction_id: String = row.get(0)?;
    let thread_id: String = row.get(1)?;
    let message_id: String = row.get(2)?;
    let emoji: String = row.get(3)?;
    let author_id: String = row.get(4)?;
    let author_kind: String = row.get(5)?;
    let author_display_name: String = row.get(6)?;
    let state: String = row.get(7)?;
    let at_ms: i64 = row.get(8)?;
    Ok((|| {
        let author_kind = ChatActorKind::from_db(&author_kind)?;
        let state = ChatReactionState::from_db(&state)?;
        if !persisted_safe_integer(at_ms) {
            return Err(DomainError::StateCorrupt {
                reason: "chat reaction row is corrupt",
            });
        }
        Ok(ChatReaction {
            reaction_id,
            thread_id,
            message_id,
            emoji,
            author_id,
            author_kind,
            author_display_name,
            state,
            at_ms,
        })
    })())
}

fn map_decision_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ChatDecision, DomainError>> {
    let thread_id: String = row.get(0)?;
    let message_id: String = row.get(1)?;
    let state: String = row.get(2)?;
    let resolved_by_message_id: Option<String> = row.get(3)?;
    let at_ms: i64 = row.get(4)?;
    Ok((|| {
        let state = ChatDecisionState::from_db(&state)?;
        if !persisted_safe_integer(at_ms) {
            return Err(DomainError::StateCorrupt {
                reason: "chat decision row is corrupt",
            });
        }
        Ok(ChatDecision {
            thread_id,
            message_id,
            state,
            resolved_by_message_id,
            at_ms,
        })
    })())
}

fn map_attachment_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ChatAttachment, DomainError>> {
    let attachment_id: String = row.get(0)?;
    let thread_id: String = row.get(1)?;
    let message_id: String = row.get(2)?;
    let target_kind: String = row.get(3)?;
    let object_id: Option<String> = row.get(4)?;
    let path_hint: Option<String> = row.get(5)?;
    let heading_text: Option<String> = row.get(6)?;
    let heading_anchor: Option<String> = row.get(7)?;
    let heading_occurrence: Option<i64> = row.get(8)?;
    let created_at_ms: i64 = row.get(9)?;
    let any_heading =
        heading_text.is_some() || heading_anchor.is_some() || heading_occurrence.is_some();
    let all_heading =
        heading_text.is_some() && heading_anchor.is_some() && heading_occurrence.is_some();
    if target_kind != "file"
        || (any_heading && !all_heading)
        || heading_occurrence.is_some_and(|value| !persisted_nonnegative_safe(value))
        || !persisted_safe_integer(created_at_ms)
    {
        return Ok(Err(DomainError::chat(
            "state-corrupt",
            "Chat attachment row is corrupt.",
        )));
    }
    Ok(Ok(ChatAttachment {
        attachment_id,
        thread_id,
        message_id,
        object_id,
        path_hint,
        heading_text,
        heading_anchor,
        heading_occurrence,
        created_at_ms,
    }))
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
    let target_kind: String = row.get(2)?;
    let message_id: Option<String> = row.get(5)?;
    let mode: String = row.get(6)?;
    let state: String = row.get(8)?;
    let created_at_ms: i64 = row.get(9)?;
    let updated_at_ms: i64 = row.get(10)?;
    let generation: i64 = row.get(11)?;
    let projected_generation: i64 = row.get(12)?;
    let projection_state: String = row.get(13)?;
    let last_projected_at_ms: Option<i64> = row.get(14)?;
    if !matches!(target_kind.as_str(), "message" | "thread")
        || !matches!(mode.as_str(), "live" | "snapshot")
        || !matches!(state.as_str(), "active" | "archived")
        || !matches!(
            projection_state.as_str(),
            "pending" | "ready" | "failed" | "stale"
        )
        || (target_kind == "message") != message_id.is_some()
        || !(1..=9_007_199_254_740_991).contains(&generation)
        || !(0..=generation).contains(&projected_generation)
        || !persisted_nonnegative_safe(created_at_ms)
        || !persisted_nonnegative_safe(updated_at_ms)
        || last_projected_at_ms.is_some_and(|value| !persisted_nonnegative_safe(value))
    {
        return Ok(Err(DomainError::chat(
            "state-corrupt",
            "Chat bookmark is corrupt.",
        )));
    }
    Ok(Ok(ChatBookmark {
        bookmark_id: row.get(0)?,
        owner_user_id: row.get(1)?,
        target_kind,
        target_id: row.get(3)?,
        thread_id: row.get(4)?,
        message_id,
        mode,
        destination_path: row.get(7)?,
        state,
        created_at_ms,
        updated_at_ms,
        generation,
        projected_generation,
        projection_state,
        last_projected_at_ms,
        projection_object_id: row.get(15)?,
        failure_reason: row.get(16)?,
    }))
}
