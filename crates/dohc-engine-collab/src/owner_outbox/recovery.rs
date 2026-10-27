use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxRestoreFenced {
    pub outbox_id: String,
    pub binding: LiveObjectBinding,
    pub pending_bytes: i64,
    pub oldest_entry_at_ms: Option<i64>,
}

/// Lists old restore generations for recovery without reopening their delivery queues.
pub fn list_restore_fenced_in(
    conn: &Connection,
    workspace_id: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<OwnerOutboxRestoreFenced>, OwnerOutboxError> {
    validate_identifier(workspace_id, "invalid workspace")?;
    if !(1..=64).contains(&limit) {
        return Err(OwnerOutboxError::InvalidInput("invalid recovery page size"));
    }
    if let Some(after) = after {
        validate_identifier(after, "invalid recovery cursor")?;
    }
    let mut stmt = conn
        .prepare(
            "SELECT o.outbox_id FROM owner_ydoc_outboxes o \
         WHERE o.workspace_id=?1 AND o.outbox_id>?2 \
           AND o.state='quarantined' AND o.quarantine_reason='restore-fenced' \
           AND o.pending_bytes>0 \
           AND EXISTS (SELECT 1 FROM ydoc_owner_bindings b \
             WHERE b.workspace_id=o.workspace_id AND b.main_version_id=o.main_version_id \
               AND b.object_id=o.object_id \
               AND json_extract(b.binding_json,'$.restoreFenceGeneration')>o.restore_fence_generation) \
         ORDER BY o.outbox_id LIMIT ?3",
        )
        .map_err(read_sql)?;
    let ids = stmt
        .query_map(
            params![workspace_id, after.unwrap_or(""), limit as i64],
            |row| row.get::<_, String>(0),
        )
        .map_err(read_sql)?;
    ids.map(|id| {
        let id = id.map_err(read_sql)?;
        let parent = read_parent(conn, &id)?.ok_or(OwnerOutboxError::Corrupt)?;
        Ok(OwnerOutboxRestoreFenced {
            outbox_id: parent.outbox_id,
            binding: parent.binding,
            pending_bytes: parent.pending_bytes,
            oldest_entry_at_ms: parent.oldest_entry_at_ms,
        })
    })
    .collect()
}
