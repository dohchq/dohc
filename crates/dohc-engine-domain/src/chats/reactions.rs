use super::{
    ChatActorKind, ChatReaction, ChatReactionState, LinkedChatStore, MAX_MESSAGE_PAGE, SetReaction,
    base32_lowercase_no_padding, bump_chat_conversation_revision, chat_after, collect, committed,
    insert_local_replication_op, is_js_trim_ws, local_replication_coordinate, lookup_request,
    map_reaction_row, nfc, non_empty, normalize_display_name, normalize_replicated_chat_id,
    persisted_safe_integer, record_request, relay_log_has_authored_message, require_thread,
    thread_has_message, validate_message_id,
};
use crate::error::DomainError;
use crate::store::hash_fields;
use dohc_engine_storage::FaultInjector;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

/// Reaction emoji bound (`REACTION_EMOJI_MAX_CHARS`) in JavaScript UTF-16 units.
const MAX_REACTION_EMOJI_UTF16_UNITS: usize = 32;
/// Reaction author ids use the same bounded identity posture as relay user ids.
const MAX_REACTION_AUTHOR_ID_UTF16_UNITS: usize = 200;

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

impl<'a> LinkedChatStore<'a> {
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
            bump_chat_conversation_revision(tx, &input.workspace_id, &thread_id)?;
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
            let (has_after, after_ms, after_id) = chat_after(after);
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
}
