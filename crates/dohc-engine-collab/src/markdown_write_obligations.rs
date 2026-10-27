use crate::{CollabError, DocKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Session,
    AuditedSettle,
    OwnerStop,
    CollectionAdoption,
    RelationCleanup,
    LinkBaseline,
    SyncProjection,
    WitnessRefresh,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session", Self::AuditedSettle => "audited-settle",
            Self::OwnerStop => "owner-stop", Self::CollectionAdoption => "collection-adoption",
            Self::RelationCleanup => "relation-cleanup", Self::LinkBaseline => "link-baseline",
            Self::SyncProjection => "sync-projection", Self::WitnessRefresh => "witness-refresh",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Obligation {
    pub order: i64,
    pub key: DocKey,
    pub lineage_claim_id: String,
    pub operation_id: String,
    pub kind: Kind,
    pub path: String,
    pub retry_inputs: serde_json::Value,
    pub held_checkpoint_sha256: Option<String>,
    pub held_head_sha256: Option<String>,
    pub source_sha256: Option<String>,
    pub settled_head_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditedRetry {
    pub namespace: String,
    pub binding: crate::live_object_binding::LiveObjectBinding,
    pub terminal_cursor: i64,
    pub head_update_seq: i64,
}

impl AuditedRetry {
    pub fn operation_id(&self) -> String {
        let b = &self.binding;
        let identity = serde_json::json!([self.namespace, b.workspace_id, b.main_version_id,
            b.object_id, b.lineage_claim_id, b.restore_fence_generation]);
        format!("live-settle:{}", crate::hex_sha256(identity.to_string().as_bytes()))
    }

    pub fn adopted_owner_in(conn: &Connection, key: &DocKey, head_update_seq: i64)
        -> Result<Option<Self>, CollabError> {
        let row: Option<(String, String, i64)> = conn.query_row(
            "SELECT relay_database_namespace,binding_json,terminal_cursor FROM live_owner_adoptions \
             WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",
            params![key.workspace_id,key.version_id,key.object_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(crate::durable::map_sql)?;
        let Some((namespace, json, adopted_cursor)) = row else { return Ok(None); };
        let binding: crate::live_object_binding::LiveObjectBinding = serde_json::from_str(&json)
            .map_err(|_| CollabError::Corrupt { reason: "adopted Markdown binding is invalid".into() })?;
        let cursor: i64 = conn.query_row(
            "SELECT COALESCE(MAX(journal_cursor),0) FROM live_device_update_applications \
             WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 \
             AND object_id=?4 AND lineage_claim_id=?5",
            params![namespace,key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id],
            |row| row.get(0)).map_err(crate::durable::map_sql)?;
        Ok(Some(Self { namespace, binding, terminal_cursor: cursor.max(adopted_cursor), head_update_seq }))
    }

    pub fn covered_in(&self, conn: &Connection) -> Result<bool, CollabError> {
        let b = &self.binding;
        conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_settlements \
            WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 \
            AND object_id=?4 AND lineage_claim_id=?5 AND local_ydoc_sequence>=?6 \
            AND (json_extract(binding_json,'$.restoreFenceGeneration')>?7 \
              OR (json_extract(binding_json,'$.restoreFenceGeneration')=?7 AND terminal_cursor>=?8)))",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,
                self.head_update_seq,b.restore_fence_generation,self.terminal_cursor],
            |row| row.get(0)).map_err(crate::durable::map_sql)
    }
}

pub fn record_audited_in(conn: &Connection, owed: &Obligation, now_ms: i64) -> Result<(), CollabError> {
    let mut retry: AuditedRetry = serde_json::from_value(owed.retry_inputs.clone())
        .map_err(|_| CollabError::Corrupt { reason: "Markdown audited retry is invalid".into() })?;
    let mut row = owed.clone();
    row.operation_id = retry.operation_id();
    row.kind = Kind::AuditedSettle;
    let previous: Option<String> = conn.query_row(
        "SELECT retry_inputs_json FROM markdown_write_obligations WHERE workspace_id=?1 \
         AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND operation_id=?5 AND kind='audited-settle'",
        params![row.key.workspace_id,row.key.version_id,row.key.object_id,row.lineage_claim_id,row.operation_id],
        |row| row.get(0)).optional().map_err(crate::durable::map_sql)?;
    if let Some(previous) = previous {
        let previous: AuditedRetry = serde_json::from_str(&previous)
            .map_err(|_| CollabError::Corrupt { reason: "Markdown audited retry is invalid".into() })?;
        retry.terminal_cursor = retry.terminal_cursor.max(previous.terminal_cursor);
        retry.head_update_seq = retry.head_update_seq.max(previous.head_update_seq);
    }
    row.retry_inputs = serde_json::to_value(retry)
        .map_err(|_| CollabError::Corrupt { reason: "Markdown audited retry is invalid".into() })?;
    record_in(conn, &row, now_ms)
}

pub fn record_in(conn: &Connection, owed: &Obligation, now_ms: i64) -> Result<(), CollabError> {
    conn.execute(
        "INSERT INTO markdown_write_obligations \
         (workspace_id,version_id,object_id,lineage_claim_id,operation_id,kind,path,\
          retry_inputs_json,held_checkpoint_sha256,held_head_sha256,source_sha256,settled_head_sha256,\
          created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13) \
         ON CONFLICT(workspace_id,version_id,object_id,lineage_claim_id,operation_id,kind) DO UPDATE SET \
          path=excluded.path,retry_inputs_json=excluded.retry_inputs_json,\
          held_checkpoint_sha256=excluded.held_checkpoint_sha256,held_head_sha256=excluded.held_head_sha256,\
          source_sha256=excluded.source_sha256,settled_head_sha256=excluded.settled_head_sha256,\
          completed=0,updated_at_ms=excluded.updated_at_ms",
        params![owed.key.workspace_id, owed.key.version_id, owed.key.object_id, owed.lineage_claim_id,
            owed.operation_id, owed.kind.as_str(), owed.path, owed.retry_inputs.to_string(),
            owed.held_checkpoint_sha256, owed.held_head_sha256, owed.source_sha256,
            owed.settled_head_sha256, now_ms],
    ).map_err(crate::durable::map_sql)?;
    Ok(())
}

pub fn pending_in(conn: &Connection, workspace_id: &str) -> Result<Vec<Obligation>, CollabError> {
    let mut statement = conn.prepare(
        "SELECT obligation_order,version_id,object_id,lineage_claim_id,operation_id,kind,path,\
          retry_inputs_json,held_checkpoint_sha256,held_head_sha256,source_sha256,settled_head_sha256 \
         FROM markdown_write_obligations WHERE workspace_id=?1 AND completed=0 \
         ORDER BY CASE kind WHEN 'collection-adoption' THEN 1 WHEN 'relation-cleanup' THEN 1 \
          ELSE 0 END,obligation_order"
    ).map_err(crate::durable::map_sql)?;
    let rows = statement.query_map([workspace_id], |row| {
        Ok((row.get::<_,i64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?,
            row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,String>(5)?,
            row.get::<_,String>(6)?, row.get::<_,String>(7)?, row.get::<_,Option<String>>(8)?,
            row.get::<_,Option<String>>(9)?, row.get::<_,Option<String>>(10)?, row.get::<_,Option<String>>(11)?))
    }).map_err(crate::durable::map_sql)?;
    let mut result = Vec::new();
    for row in rows {
        let (order, version, object, lineage_claim_id, operation_id, kind, path, inputs,
            held_checkpoint_sha256, held_head_sha256, source_sha256, settled_head_sha256) =
            row.map_err(crate::durable::map_sql)?;
        result.push(Obligation {
            order, key: DocKey::new(workspace_id, version, object)?, lineage_claim_id, operation_id,
            kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(|_| CollabError::Corrupt {
                reason: "Markdown write obligation kind is invalid".into(),
            })?, path, retry_inputs: serde_json::from_str(&inputs).map_err(|_| CollabError::Corrupt {
                reason: "Markdown write obligation inputs are invalid".into(),
            })?, held_checkpoint_sha256, held_head_sha256, source_sha256, settled_head_sha256,
        });
    }
    Ok(result)
}

pub fn complete_in(conn: &Connection, owed: &Obligation, now_ms: i64) -> Result<(), CollabError> {
    conn.execute("UPDATE markdown_write_obligations SET completed=1,updated_at_ms=?7 \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 \
        AND operation_id=?5 AND kind=?6",
        params![owed.key.workspace_id,owed.key.version_id,owed.key.object_id,owed.lineage_claim_id,
            owed.operation_id,owed.kind.as_str(),now_ms]).map_err(crate::durable::map_sql)?;
    Ok(())
}

pub fn complete_covered_audited_in(conn: &Connection, key: &DocKey, now_ms: i64) -> Result<(), CollabError> {
    for owed in pending_in(conn, &key.workspace_id)? {
        if owed.key != *key || owed.kind != Kind::AuditedSettle { continue; }
        let retry: AuditedRetry = serde_json::from_value(owed.retry_inputs.clone())
            .map_err(|_| CollabError::Corrupt { reason: "Markdown audited retry is invalid".into() })?;
        if retry.covered_in(conn)? { complete_in(conn, &owed, now_ms)?; }
    }
    Ok(())
}

pub fn advance_refresh_head_in(conn: &Connection, key: &DocKey, lineage: Option<&str>,
    previous_head: Option<&str>, settled_head: &str, now_ms: i64) -> Result<(), CollabError> {
    conn.execute("UPDATE markdown_write_obligations SET settled_head_sha256=?6,updated_at_ms=?7 \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 \
        AND kind='witness-refresh' AND completed=0 AND settled_head_sha256=?5 \
        AND source_sha256!=?6",
        params![key.workspace_id,key.version_id,key.object_id,lineage.unwrap_or(""),
            previous_head,settled_head,now_ms]).map_err(crate::durable::map_sql)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_audited_hold_coalesces_and_requires_cursor_and_native_sequence() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../dohc-engine-storage/src/markdown_write_obligations.sql")).unwrap();
        conn.execute_batch("CREATE TABLE live_device_settlements(relay_database_namespace TEXT,workspace_id TEXT,\
            main_version_id TEXT,object_id TEXT,lineage_claim_id TEXT,terminal_cursor INTEGER,\
            local_ydoc_sequence INTEGER,binding_json TEXT)").unwrap();
        let retry = AuditedRetry { namespace: "relay".into(), binding: crate::live_object_binding::LiveObjectBinding {
            workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
            lineage_claim_id: "claim".into(), current_path: "note.md".into(), selector_paths: vec!["note.md".into()],
            restore_fence_generation: 0,
        }, terminal_cursor: 7, head_update_seq: 12 };
        let mut owed = Obligation {
            order: 0, key: DocKey::new("w", "main", "note").unwrap(), lineage_claim_id: "claim".into(),
            operation_id: retry.operation_id(), kind: Kind::AuditedSettle, path: "note.md".into(),
            retry_inputs: serde_json::to_value(&retry).unwrap(), held_checkpoint_sha256: None,
            held_head_sha256: None, source_sha256: None, settled_head_sha256: None,
        };
        record_audited_in(&conn, &owed, 1).unwrap();
        owed.retry_inputs = serde_json::to_value(AuditedRetry { terminal_cursor: 9, head_update_seq: 14, ..retry.clone() }).unwrap();
        record_audited_in(&conn, &owed, 2).unwrap();
        // A delayed older hold cannot lower either bound.
        owed.retry_inputs = serde_json::to_value(&retry).unwrap();
        record_audited_in(&conn, &owed, 3).unwrap();
        let rows = pending_in(&conn, "w").unwrap();
        assert_eq!(rows.len(), 1);
        let held: AuditedRetry = serde_json::from_value(rows[0].retry_inputs.clone()).unwrap();
        assert_eq!((held.terminal_cursor, held.head_update_seq), (9, 14));
        conn.execute("INSERT INTO live_device_settlements VALUES ('relay','w','main','note','claim',9,12,?1)",
            [serde_json::to_string(&retry.binding).unwrap()]).unwrap();
        assert!(!held.covered_in(&conn).unwrap());
        conn.execute("UPDATE live_device_settlements SET local_ydoc_sequence=14,terminal_cursor=8", []).unwrap();
        assert!(!held.covered_in(&conn).unwrap());
        conn.execute("UPDATE live_device_settlements SET terminal_cursor=9", []).unwrap();
        assert!(held.covered_in(&conn).unwrap());
        let restored = crate::live_object_binding::LiveObjectBinding { restore_fence_generation: 1, ..retry.binding };
        conn.execute("UPDATE live_device_settlements SET binding_json=?1,terminal_cursor=0,local_ydoc_sequence=12",
            [serde_json::to_string(&restored).unwrap()]).unwrap();
        assert!(!held.covered_in(&conn).unwrap());
        conn.execute("UPDATE live_device_settlements SET local_ydoc_sequence=14", []).unwrap();
        assert!(held.covered_in(&conn).unwrap());
        complete_covered_audited_in(&conn, &owed.key, 4).unwrap();
        assert!(pending_in(&conn, "w").unwrap().is_empty());
    }

    #[test]
    fn markdown_refresh_tracks_only_ordinary_successors_of_its_consented_head() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../dohc-engine-storage/src/markdown_write_obligations.sql")).unwrap();
        let key = DocKey::new("w", "main", "object").unwrap();
        let owed = Obligation {
            order: 0, key: key.clone(), lineage_claim_id: "claim".into(), operation_id: "session".into(),
            kind: Kind::WitnessRefresh, path: "note.md".into(), retry_inputs: serde_json::json!({}),
            held_checkpoint_sha256: None, held_head_sha256: None,
            source_sha256: Some("source".into()), settled_head_sha256: Some("converted".into()),
        };
        record_in(&conn, &owed, 1).unwrap();
        advance_refresh_head_in(&conn, &key, Some("other"), Some("converted"), "wrong-lineage", 2).unwrap();
        advance_refresh_head_in(&conn, &key, Some("claim"), Some("outside"), "outside-edit", 3).unwrap();
        advance_refresh_head_in(&conn, &key, Some("claim"), Some("converted"), "source", 4).unwrap();
        assert_eq!(pending_in(&conn, "w").unwrap()[0].settled_head_sha256.as_deref(), Some("converted"));
        advance_refresh_head_in(&conn, &key, Some("claim"), Some("converted"), "next-settlement", 5).unwrap();
        let pending = pending_in(&conn, "w").unwrap();
        assert_eq!(pending[0].source_sha256.as_deref(), Some("source"));
        assert_eq!(pending[0].settled_head_sha256.as_deref(), Some("next-settlement"));
        complete_in(&conn, &pending[0], 6).unwrap();
        assert!(pending_in(&conn, "w").unwrap().is_empty());
    }
}
