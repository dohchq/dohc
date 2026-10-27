use crate::{CollabError, DocKey};
use rusqlite::{params, Connection};
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
    pub settled_cut: Option<i64>,
    pub settled_head_sha256: Option<String>,
}

pub fn record_in(conn: &Connection, owed: &Obligation, now_ms: i64) -> Result<(), CollabError> {
    conn.execute(
        "INSERT INTO markdown_write_obligations \
         (workspace_id,version_id,object_id,lineage_claim_id,operation_id,kind,path,\
          retry_inputs_json,held_checkpoint_sha256,held_head_sha256,settled_cut,settled_head_sha256,\
          created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13) \
         ON CONFLICT(workspace_id,version_id,object_id,lineage_claim_id,operation_id,kind) DO UPDATE SET \
          path=excluded.path,retry_inputs_json=excluded.retry_inputs_json,\
          held_checkpoint_sha256=excluded.held_checkpoint_sha256,held_head_sha256=excluded.held_head_sha256,\
          settled_cut=excluded.settled_cut,settled_head_sha256=excluded.settled_head_sha256,\
          completed=0,updated_at_ms=excluded.updated_at_ms",
        params![owed.key.workspace_id, owed.key.version_id, owed.key.object_id, owed.lineage_claim_id,
            owed.operation_id, owed.kind.as_str(), owed.path, owed.retry_inputs.to_string(),
            owed.held_checkpoint_sha256, owed.held_head_sha256, owed.settled_cut,
            owed.settled_head_sha256, now_ms],
    ).map_err(crate::durable::map_sql)?;
    Ok(())
}

pub fn pending_in(conn: &Connection, workspace_id: &str) -> Result<Vec<Obligation>, CollabError> {
    let mut statement = conn.prepare(
        "SELECT obligation_order,version_id,object_id,lineage_claim_id,operation_id,kind,path,\
          retry_inputs_json,held_checkpoint_sha256,held_head_sha256,settled_cut,settled_head_sha256 \
         FROM markdown_write_obligations WHERE workspace_id=?1 AND completed=0 \
         ORDER BY CASE kind WHEN 'collection-adoption' THEN 1 WHEN 'relation-cleanup' THEN 1 \
          WHEN 'sync-projection' THEN 2 ELSE 0 END,obligation_order"
    ).map_err(crate::durable::map_sql)?;
    let rows = statement.query_map([workspace_id], |row| {
        Ok((row.get::<_,i64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?,
            row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,String>(5)?,
            row.get::<_,String>(6)?, row.get::<_,String>(7)?, row.get::<_,Option<String>>(8)?,
            row.get::<_,Option<String>>(9)?, row.get::<_,Option<i64>>(10)?, row.get::<_,Option<String>>(11)?))
    }).map_err(crate::durable::map_sql)?;
    let mut result = Vec::new();
    for row in rows {
        let (order, version, object, lineage_claim_id, operation_id, kind, path, inputs,
            held_checkpoint_sha256, held_head_sha256, settled_cut, settled_head_sha256) =
            row.map_err(crate::durable::map_sql)?;
        result.push(Obligation {
            order, key: DocKey::new(workspace_id, version, object)?, lineage_claim_id, operation_id,
            kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(|_| CollabError::Corrupt {
                reason: "Markdown write obligation kind is invalid".into(),
            })?, path, retry_inputs: serde_json::from_str(&inputs).map_err(|_| CollabError::Corrupt {
                reason: "Markdown write obligation inputs are invalid".into(),
            })?, held_checkpoint_sha256, held_head_sha256, settled_cut, settled_head_sha256,
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
