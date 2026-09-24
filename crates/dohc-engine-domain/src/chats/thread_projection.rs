use super::{
    ChatActorKind, ChatMessage, ChatProjectionFileAccess, ChatThread, ChatThreadProjection,
    LINKED_CHAT_PROJECTION_KIND, LinkedChatStore, base32_lowercase_no_padding, collect,
    has_projection_control_char, hydrate_attachments_for_messages, is_js_trim_ws, map_message_row,
    nfc, normalize_attachment_path_hint, require_thread,
};
use crate::error::DomainError;
use rusqlite::params;
use sha2::{Digest, Sha256};

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
            ChatActorKind::Automation => format!("{} (automation)", message.author_display_name),
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

impl<'a> LinkedChatStore<'a> {
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
                     author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name, \
                     automation_id, chain_depth \
                     FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
                     ORDER BY created_at_ms, message_id",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, thread_id], map_message_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut messages: Vec<ChatMessage> = collect(rows)?;
            hydrate_attachments_for_messages(conn, workspace_id, &mut messages)?;
            Ok(ChatThreadProjection {
                path: linked_chat_projection_path(workspace_id, &thread.thread_id, None)?,
                read_only: true,
                thread_id: thread.thread_id.clone(),
                text: render_chat_thread_projection(&thread, &messages, &linked_file_access)?,
            })
        })
    }
}
