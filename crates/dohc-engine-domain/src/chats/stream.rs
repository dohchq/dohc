//! A group's stream: its posts and its conversation's top-level messages as
//! one list, oldest first, read a page at a time from the newest end.

use super::{
    ChatActorKind, ChatChannel, ChatMessage, ChatMessageLinkAuthor, ChatReaction, ChatThread,
    ChatThreadLane, FEED_LIMIT_MAX, LinkedChatStore, active_reactions_for_messages, collect,
    hydrate_attachments_for_messages, map_message_row, message_count_for_thread,
    persisted_nonnegative_safe, require_channel, require_thread,
};
use crate::error::DomainError;
use rusqlite::{Connection, params};
use std::collections::HashMap;

/// Stream pages default to this many items.
pub const STREAM_LIMIT_DEFAULT: i64 = 50;
/// An agent reply's excerpt keeps this many characters (Unicode scalar values).
pub const AGENT_REPLY_EXCERPT_CHARS: usize = 280;
/// A post names at most this many repliers.
const STREAM_REPLIERS_MAX: usize = 3;

/// Where an item sits in a group's stream. Items sort by time, then lane (a
/// post before a conversation message in the same millisecond), then id: the
/// thread id for a post, the message id for a conversation message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPosition {
    pub created_at_ms: i64,
    pub lane: ChatThreadLane,
    pub id: String,
}

impl StreamPosition {
    fn key(&self) -> (i64, u8, &str) {
        let lane = match self.lane {
            ChatThreadLane::Posts => 0,
            ChatThreadLane::Chat => 1,
        };
        (self.created_at_ms, lane, &self.id)
    }

    /// The `(created_at_ms, id)` bound below which one lane's rows sort before
    /// this position. An id compares above `""`, so `(t, "")` excludes all of
    /// millisecond `t`, and `(t + 1, "")` includes all of it.
    fn bound_for(&self, lane: ChatThreadLane) -> (i64, &str) {
        match (lane, self.lane) {
            (ChatThreadLane::Posts, ChatThreadLane::Chat) => {
                (self.created_at_ms.saturating_add(1), "")
            }
            (ChatThreadLane::Chat, ChatThreadLane::Posts) => (self.created_at_ms, ""),
            _ => (self.created_at_ms, &self.id),
        }
    }
}

/// One person or agent who replied to a post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamReplier {
    pub author_kind: ChatActorKind,
    pub author_display_name: String,
    pub author_user_id: Option<String>,
    /// The share link a link holder replied through.
    pub link_author: Option<ChatMessageLinkAuthor>,
    /// The agent that replied in one of its runs. Provenance only.
    pub author_agent_id: Option<String>,
    pub last_reply_at_ms: i64,
}

/// A post's latest agent reply, cut to its first
/// [`AGENT_REPLY_EXCERPT_CHARS`] characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamAgentReply {
    pub message_id: String,
    pub author_display_name: String,
    pub author_owner_display_name: Option<String>,
    pub author_user_id: Option<String>,
    /// The agent that wrote the reply in one of its runs.
    pub author_agent_id: Option<String>,
    pub created_at_ms: i64,
    pub body_excerpt: String,
}

/// What a post's thread holds beyond its first message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPost {
    pub reply_count: i64,
    /// Distinct repliers, newest first.
    pub repliers: Vec<StreamReplier>,
    pub last_reply_at_ms: Option<i64>,
    pub latest_agent_reply: Option<StreamAgentReply>,
    pub open_decision_count: i64,
}

/// Where an agent request for a message stands. A request whose run finished
/// is left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamAgentRequestState {
    Waiting,
    Running,
    Failed,
}

impl StreamAgentRequestState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Running => "running",
            Self::Failed => "failed",
        }
    }
}

/// One agent's request to answer a message, with its run's facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamAgentRequest {
    pub agent_id: String,
    pub state: StreamAgentRequestState,
    /// Absent while the request waits.
    pub run_id: Option<String>,
    pub started_at_ms: Option<i64>,
    /// A failed request's reason, exit code and log, as its run recorded them.
    pub failure_reason: Option<String>,
    pub exit_code: Option<i64>,
    pub log_path: Option<String>,
}

/// One top-level item: a post's first message, or a conversation message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamItem {
    pub position: StreamPosition,
    pub message: ChatMessage,
    pub reactions: Vec<ChatReaction>,
    pub agent_requests: Vec<StreamAgentRequest>,
    /// Set for, and only for, a post.
    pub post: Option<StreamPost>,
}

/// A page of a group's stream, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPage {
    pub items: Vec<StreamItem>,
    /// Older items exist before the first one.
    pub has_older: bool,
    /// The newest item the person has read: a post whose thread they have read
    /// into, or a conversation message under the conversation's read cursor.
    pub read_position: Option<StreamPosition>,
}

/// One thread with its group and size, for a reader that needs only them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadWithChannel {
    pub thread: ChatThread,
    pub channel: Option<ChatChannel>,
    pub message_count: i64,
}

const MESSAGE_COLUMNS: &str = "workspace_id, thread_id, message_order, message_id, author_kind, \
     author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms, \
     author_owner_display_name, automation_id, chain_depth, author_actor_key, link_grant_id, \
     link_principal_id, author_agent_id";

fn corrupt(reason: &'static str) -> DomainError {
    DomainError::StateCorrupt { reason }
}

fn json_ids(ids: &[String]) -> Result<String, DomainError> {
    serde_json::to_string(ids).map_err(|_| corrupt("stream id set is corrupt"))
}

fn checked_count(value: i64, reason: &'static str) -> Result<i64, DomainError> {
    if persisted_nonnegative_safe(value) {
        Ok(value)
    } else {
        Err(corrupt(reason))
    }
}

struct PostFacts {
    opening_id: String,
    message_count: i64,
    last_reply_at_ms: Option<i64>,
    latest_agent_reply_id: Option<String>,
    open_decision_count: i64,
}

impl<'a> LinkedChatStore<'a> {
    /// One page of a group's stream, ending just before `before` (or at the
    /// newest item). Each lane reads at most `limit + 1` rows from its index,
    /// so a page costs the same however long the group is.
    pub fn list_group_stream(
        &self,
        workspace_id: &str,
        channel_id: &str,
        before: Option<&StreamPosition>,
        limit: i64,
    ) -> Result<StreamPage, DomainError> {
        if !(1..=FEED_LIMIT_MAX).contains(&limit) {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Page limit is invalid.",
            ));
        }
        if let Some(before) = before
            && (!persisted_nonnegative_safe(before.created_at_ms) || before.id.is_empty())
        {
            return Err(DomainError::chat(
                "invalid-cursor",
                "Stream cursor is invalid.",
            ));
        }
        self.store.read_with(|conn| {
            let channel = require_channel(conn, workspace_id, channel_id)?;
            let channel_id = channel.channel_id.as_str();
            let probe = limit + 1;
            let bound = |lane| before.map_or((i64::MAX, ""), |position| position.bound_for(lane));

            let mut keys: Vec<(StreamPosition, String)> = Vec::new();
            {
                let (bound_ms, bound_id) = bound(ChatThreadLane::Posts);
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT t.created_at_ms, t.thread_id FROM chat_threads t \
                         WHERE t.workspace_id = ?1 AND t.channel_id = ?2 AND t.lane = 'posts' \
                           AND (t.created_at_ms, t.thread_id) < (?3, ?4) \
                           AND EXISTS (SELECT 1 FROM chat_messages m \
                             WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id) \
                         ORDER BY t.created_at_ms DESC, t.thread_id DESC LIMIT ?5",
                    )
                    .map_err(DomainError::sql_corrupt)?;
                let rows = stmt
                    .query_map(
                        params![workspace_id, channel_id, bound_ms, bound_id, probe],
                        |row| {
                            Ok(Ok::<_, DomainError>((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                            )))
                        },
                    )
                    .map_err(DomainError::sql_corrupt)?;
                for (created_at_ms, thread_id) in collect(rows)? {
                    keys.push((
                        StreamPosition {
                            created_at_ms,
                            lane: ChatThreadLane::Posts,
                            id: thread_id.clone(),
                        },
                        thread_id,
                    ));
                }
            }

            let conversations = conversation_threads(conn, workspace_id, channel_id)?;
            {
                let (bound_ms, bound_id) = bound(ChatThreadLane::Chat);
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT created_at_ms, message_id FROM chat_messages \
                         WHERE workspace_id = ?1 AND thread_id = ?2 AND parent_message_id IS NULL \
                           AND (created_at_ms, message_id) < (?3, ?4) \
                         ORDER BY created_at_ms DESC, message_id DESC LIMIT ?5",
                    )
                    .map_err(DomainError::sql_corrupt)?;
                for (thread_id, _) in &conversations {
                    let rows = stmt
                        .query_map(
                            params![workspace_id, thread_id, bound_ms, bound_id, probe],
                            |row| {
                                Ok(Ok::<_, DomainError>((
                                    row.get::<_, i64>(0)?,
                                    row.get::<_, String>(1)?,
                                )))
                            },
                        )
                        .map_err(DomainError::sql_corrupt)?;
                    for (created_at_ms, message_id) in collect(rows)? {
                        keys.push((
                            StreamPosition {
                                created_at_ms,
                                lane: ChatThreadLane::Chat,
                                id: message_id,
                            },
                            thread_id.clone(),
                        ));
                    }
                }
            }

            keys.sort_by(|left, right| right.0.key().cmp(&left.0.key()));
            let has_older = keys.len() as i64 > limit;
            keys.truncate(limit as usize);
            keys.reverse();

            let post_thread_ids: Vec<String> = keys
                .iter()
                .filter(|(position, _)| position.lane == ChatThreadLane::Posts)
                .map(|(_, thread_id)| thread_id.clone())
                .collect();
            let mut facts = post_facts(conn, workspace_id, &post_thread_ids)?;
            let opening_ids: Vec<String> =
                facts.values().map(|fact| fact.opening_id.clone()).collect();
            let mut repliers = post_repliers(conn, workspace_id, &post_thread_ids, &opening_ids)?;

            let item_ids: Vec<String> = keys
                .iter()
                .filter_map(|(position, thread_id)| match position.lane {
                    ChatThreadLane::Chat => Some(position.id.clone()),
                    ChatThreadLane::Posts => {
                        facts.get(thread_id).map(|fact| fact.opening_id.clone())
                    }
                })
                .collect();
            let agent_reply_ids: Vec<String> = facts
                .values()
                .filter_map(|fact| fact.latest_agent_reply_id.clone())
                .collect();
            let mut messages = messages_by_id(conn, workspace_id, &item_ids)?;
            hydrate_attachments_for_messages(conn, workspace_id, messages.values_mut())?;
            let mut agent_replies = messages_by_id(conn, workspace_id, &agent_reply_ids)?;
            let mut reactions = active_reactions_for_messages(conn, workspace_id, &item_ids)?;
            let mut requests = agent_requests_for_messages(conn, workspace_id, &item_ids)?;

            let mut items = Vec::with_capacity(keys.len());
            for (position, thread_id) in keys {
                let (message_id, post) = match position.lane {
                    ChatThreadLane::Chat => (position.id.clone(), None),
                    ChatThreadLane::Posts => {
                        let fact = facts
                            .remove(&thread_id)
                            .ok_or_else(|| corrupt("stream post lost its thread"))?;
                        let latest_agent_reply = match &fact.latest_agent_reply_id {
                            Some(id) => Some(agent_reply(
                                agent_replies
                                    .remove(id)
                                    .ok_or_else(|| corrupt("stream agent reply is missing"))?,
                            )),
                            None => None,
                        };
                        let post = StreamPost {
                            reply_count: fact.message_count - 1,
                            repliers: repliers.remove(&thread_id).unwrap_or_default(),
                            last_reply_at_ms: fact.last_reply_at_ms,
                            latest_agent_reply,
                            open_decision_count: fact.open_decision_count,
                        };
                        (fact.opening_id, Some(post))
                    }
                };
                let message = messages
                    .remove(&message_id)
                    .ok_or_else(|| corrupt("stream item message is missing"))?;
                items.push(StreamItem {
                    reactions: reactions.remove(&message_id).unwrap_or_default(),
                    agent_requests: requests.remove(&message_id).unwrap_or_default(),
                    position,
                    message,
                    post,
                });
            }

            let read_position = read_position(conn, workspace_id, channel_id, &conversations)?;
            Ok(StreamPage {
                items,
                has_older,
                read_position,
            })
        })
    }

    /// One thread, its group, and its message count.
    pub fn get_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadWithChannel, DomainError> {
        self.store.read_with(|conn| {
            let thread = require_thread(conn, workspace_id, thread_id)?;
            let channel = match &thread.channel_id {
                Some(channel_id) => Some(require_channel(conn, workspace_id, channel_id)?),
                None => None,
            };
            let message_count = checked_count(
                message_count_for_thread(conn, workspace_id, thread_id)?,
                "thread message count is corrupt",
            )?;
            Ok(ThreadWithChannel {
                thread,
                channel,
                message_count,
            })
        })
    }
}

/// The group's conversation threads with each one's read cursor. A group has
/// one, unless two devices started its conversation before they synced.
fn conversation_threads(
    conn: &Connection,
    workspace_id: &str,
    channel_id: &str,
) -> Result<Vec<(String, i64)>, DomainError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT t.thread_id, COALESCE(r.last_read_sequence, 0) FROM chat_threads t \
             LEFT JOIN chat_thread_read_state r \
               ON r.workspace_id = t.workspace_id AND r.thread_id = t.thread_id \
             WHERE t.workspace_id = ?1 AND t.channel_id = ?2 AND t.lane = 'chat' \
             ORDER BY t.created_at_ms, t.thread_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, channel_id], |row| {
            let thread_id: String = row.get(0)?;
            let read: i64 = row.get(1)?;
            Ok(checked_count(read, "stream read cursor is corrupt").map(|read| (thread_id, read)))
        })
        .map_err(DomainError::sql_corrupt)?;
    collect(rows)
}

fn post_facts(
    conn: &Connection,
    workspace_id: &str,
    thread_ids: &[String],
) -> Result<HashMap<String, PostFacts>, DomainError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // The first message by (created_at_ms, message_id) opens the post, as in
    // the thread listing. Every other message is a reply. Here and below, a
    // CROSS JOIN makes the page's ids lead; with a plain JOIN, SQLite can scan
    // every message in the workspace instead (48 ms over 10,000 posts).
    let mut stmt = conn
        .prepare_cached(
            "WITH page AS ( \
               SELECT t.workspace_id, t.thread_id, \
                      (SELECT m.message_id FROM chat_messages m \
                       WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                       ORDER BY m.created_at_ms, m.message_id LIMIT 1) AS opening_id \
               FROM json_each(?2) ids \
               CROSS JOIN chat_threads t ON t.workspace_id = ?1 AND t.thread_id = ids.value \
             ) \
             SELECT p.thread_id, p.opening_id, \
                    (SELECT COUNT(*) FROM chat_messages m \
                     WHERE m.workspace_id = p.workspace_id AND m.thread_id = p.thread_id), \
                    (SELECT m.created_at_ms FROM chat_messages m \
                     WHERE m.workspace_id = p.workspace_id AND m.thread_id = p.thread_id \
                       AND m.message_id <> p.opening_id \
                     ORDER BY m.created_at_ms DESC, m.message_id DESC LIMIT 1), \
                    (SELECT m.message_id FROM chat_messages m \
                     WHERE m.workspace_id = p.workspace_id AND m.thread_id = p.thread_id \
                       AND m.message_id <> p.opening_id AND m.author_kind = 'agent' \
                     ORDER BY m.created_at_ms DESC, m.message_id DESC LIMIT 1), \
                    (SELECT COUNT(*) FROM chat_decisions d \
                     JOIN chat_messages m ON m.workspace_id = d.workspace_id \
                       AND m.thread_id = d.thread_id AND m.message_id = d.message_id \
                     WHERE d.workspace_id = p.workspace_id AND d.thread_id = p.thread_id \
                       AND d.state = 'open') \
             FROM page p WHERE p.opening_id IS NOT NULL",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, json_ids(thread_ids)?], |row| {
            let thread_id: String = row.get(0)?;
            let opening_id: String = row.get(1)?;
            let message_count: i64 = row.get(2)?;
            let last_reply_at_ms: Option<i64> = row.get(3)?;
            let latest_agent_reply_id: Option<String> = row.get(4)?;
            let open_decision_count: i64 = row.get(5)?;
            Ok((|| {
                Ok((
                    thread_id,
                    PostFacts {
                        opening_id,
                        message_count: checked_count(
                            message_count,
                            "stream post message count is corrupt",
                        )?
                        .max(1),
                        last_reply_at_ms,
                        latest_agent_reply_id,
                        open_decision_count: checked_count(
                            open_decision_count,
                            "stream post decision count is corrupt",
                        )?,
                    },
                ))
            })())
        })
        .map_err(DomainError::sql_corrupt)?;
    Ok(collect(rows)?.into_iter().collect())
}

/// Each post's distinct repliers, newest first. A replier is one author kind,
/// display name and account.
fn post_repliers(
    conn: &Connection,
    workspace_id: &str,
    thread_ids: &[String],
    opening_ids: &[String],
) -> Result<HashMap<String, Vec<StreamReplier>>, DomainError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT m.thread_id, m.author_kind, m.author_display_name, m.author_user_id, \
                    MAX(m.created_at_ms) AS at, m.link_grant_id, m.link_principal_id, m.author_agent_id \
             FROM json_each(?2) ids \
             CROSS JOIN chat_messages m ON m.workspace_id = ?1 AND m.thread_id = ids.value \
             WHERE m.message_id NOT IN (SELECT value FROM json_each(?3)) \
             GROUP BY m.thread_id, m.author_kind, m.author_display_name, m.author_user_id, \
                      m.link_grant_id, m.link_principal_id, m.author_agent_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, json_ids(thread_ids)?, json_ids(opening_ids)?],
            |row| {
                let thread_id: String = row.get(0)?;
                let kind: String = row.get(1)?;
                let author_display_name: String = row.get(2)?;
                let author_user_id: Option<String> = row.get(3)?;
                let last_reply_at_ms: i64 = row.get(4)?;
                let link_grant_id: Option<String> = row.get(5)?;
                let link_principal_id: Option<String> = row.get(6)?;
                let author_agent_id: Option<String> = row.get(7)?;
                let link_author = match (link_grant_id, link_principal_id) {
                    (Some(grant_id), Some(principal_id)) => Some(ChatMessageLinkAuthor {
                        grant_id,
                        principal_id,
                    }),
                    _ => None,
                };
                Ok(ChatActorKind::from_db(&kind).map(|author_kind| {
                    (
                        thread_id,
                        StreamReplier {
                            author_kind,
                            author_display_name,
                            author_user_id,
                            link_author,
                            author_agent_id,
                            last_reply_at_ms,
                        },
                    )
                }))
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut grouped: HashMap<String, Vec<StreamReplier>> = HashMap::new();
    for (thread_id, replier) in collect(rows)? {
        grouped.entry(thread_id).or_default().push(replier);
    }
    for repliers in grouped.values_mut() {
        repliers.sort_by(|left, right| {
            right
                .last_reply_at_ms
                .cmp(&left.last_reply_at_ms)
                .then_with(|| left.author_display_name.cmp(&right.author_display_name))
        });
        repliers.truncate(STREAM_REPLIERS_MAX);
    }
    Ok(grouped)
}

fn messages_by_id(
    conn: &Connection,
    workspace_id: &str,
    message_ids: &[String],
) -> Result<HashMap<String, ChatMessage>, DomainError> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM chat_messages \
             WHERE workspace_id = ?1 AND message_id IN (SELECT value FROM json_each(?2))"
        ))
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, json_ids(message_ids)?],
            map_message_row,
        )
        .map_err(DomainError::sql_corrupt)?;
    Ok(collect(rows)?
        .into_iter()
        .map(|message| (message.message_id.clone(), message))
        .collect())
}

/// Each message's open agent requests: waiting, running, or failed. A request
/// a running run took in with its own (the ledger marks it done under that
/// run) runs until the run ends. A run that ended without failing in the
/// ledger failed when desktop handled its failure: a nonzero exit, or no reply.
pub(super) fn agent_requests_for_messages(
    conn: &Connection,
    workspace_id: &str,
    message_ids: &[String],
) -> Result<HashMap<String, Vec<StreamAgentRequest>>, DomainError> {
    let mut grouped: HashMap<String, Vec<StreamAgentRequest>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(grouped);
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT l.trigger_message_id, l.agent_id, \
                    CASE WHEN l.state = 'done' AND r.ended_at_ms IS NULL THEN 'running' \
                         WHEN l.state = 'done' THEN 'failed' ELSE l.state END, \
                    l.run_id, r.started_at_ms, \
                    COALESCE(l.failure_reason, r.failure_reason, \
                             CASE WHEN l.state = 'done' AND r.exit_code = 0 THEN 'no-reply' END), \
                    r.exit_code, r.log_path \
             FROM json_each(?2) ids \
             CROSS JOIN chat_dispatch_ledger l \
               ON l.workspace_id = ?1 AND l.trigger_message_id = ids.value \
             LEFT JOIN agent_run_records r \
               ON r.workspace_id = l.workspace_id AND r.run_id = l.run_id \
                  AND r.agent_id = l.agent_id \
             WHERE l.state IN ('pending', 'running', 'failed') \
                OR (l.state = 'done' AND r.run_id IS NOT NULL \
                    AND (r.ended_at_ms IS NULL OR r.failure_handled = 1)) \
             ORDER BY l.trigger_message_id, l.agent_id",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, json_ids(message_ids)?], |row| {
            let message_id: String = row.get(0)?;
            let agent_id: String = row.get(1)?;
            let state: String = row.get(2)?;
            let run_id: Option<String> = row.get(3)?;
            let started_at_ms: Option<i64> = row.get(4)?;
            let failure_reason: Option<String> = row.get(5)?;
            let exit_code: Option<i64> = row.get(6)?;
            let log_path: Option<String> = row.get(7)?;
            let state = match state.as_str() {
                "pending" => StreamAgentRequestState::Waiting,
                "running" => StreamAgentRequestState::Running,
                "failed" => StreamAgentRequestState::Failed,
                _ => return Ok(Err(corrupt("agent request state is corrupt"))),
            };
            let waiting = state == StreamAgentRequestState::Waiting;
            let failed = state == StreamAgentRequestState::Failed;
            Ok(Ok((
                message_id,
                StreamAgentRequest {
                    agent_id,
                    state,
                    run_id: run_id.filter(|_| !waiting),
                    started_at_ms: started_at_ms.filter(|_| !waiting),
                    failure_reason: failure_reason.filter(|_| failed),
                    exit_code: exit_code.filter(|_| failed),
                    log_path: log_path.filter(|_| failed),
                },
            )))
        })
        .map_err(DomainError::sql_corrupt)?;
    for (message_id, request) in collect(rows)? {
        grouped.entry(message_id).or_default().push(request);
    }
    Ok(grouped)
}

fn agent_reply(message: ChatMessage) -> StreamAgentReply {
    StreamAgentReply {
        body_excerpt: message
            .body
            .chars()
            .take(AGENT_REPLY_EXCERPT_CHARS)
            .collect(),
        message_id: message.message_id,
        author_display_name: message.author_display_name,
        author_owner_display_name: message.author_owner_display_name,
        author_user_id: message.author_user_id,
        author_agent_id: message.author_agent_id,
        created_at_ms: message.created_at_ms,
    }
}

/// The newest of: the newest post whose thread the person has read into, and
/// each conversation's newest top-level message under its read cursor. Each
/// scan stops at the first read row, so it reads only the unread rows above it.
fn read_position(
    conn: &Connection,
    workspace_id: &str,
    channel_id: &str,
    conversations: &[(String, i64)],
) -> Result<Option<StreamPosition>, DomainError> {
    let mut newest: Option<StreamPosition> = conn
        .prepare_cached(
            "SELECT t.created_at_ms, t.thread_id FROM chat_threads t \
             CROSS JOIN chat_thread_read_state r \
             WHERE t.workspace_id = ?1 AND t.channel_id = ?2 AND t.lane = 'posts' \
               AND r.workspace_id = t.workspace_id AND r.thread_id = t.thread_id \
               AND r.last_read_sequence >= 1 \
             ORDER BY t.created_at_ms DESC, t.thread_id DESC LIMIT 1",
        )
        .map_err(DomainError::sql_corrupt)?
        .query_map(params![workspace_id, channel_id], |row| {
            Ok(Ok::<_, DomainError>(StreamPosition {
                created_at_ms: row.get(0)?,
                lane: ChatThreadLane::Posts,
                id: row.get(1)?,
            }))
        })
        .map_err(DomainError::sql_corrupt)
        .and_then(collect)?
        .pop();
    let mut stmt = conn
        .prepare_cached(
            "SELECT created_at_ms, message_id FROM chat_messages \
             WHERE workspace_id = ?1 AND thread_id = ?2 AND parent_message_id IS NULL \
               AND message_order < ?3 \
             ORDER BY created_at_ms DESC, message_id DESC LIMIT 1",
        )
        .map_err(DomainError::sql_corrupt)?;
    for (thread_id, read) in conversations.iter().filter(|(_, read)| *read > 0) {
        let rows = stmt
            .query_map(params![workspace_id, thread_id, read], |row| {
                Ok(Ok::<_, DomainError>(StreamPosition {
                    created_at_ms: row.get(0)?,
                    lane: ChatThreadLane::Chat,
                    id: row.get(1)?,
                }))
            })
            .map_err(DomainError::sql_corrupt)?;
        if let Some(position) = collect(rows)?.pop()
            && newest
                .as_ref()
                .is_none_or(|current| position.key() > current.key())
        {
            newest = Some(position);
        }
    }
    Ok(newest)
}
