use crate::{ChangeAttribution, DomainError};
use dohc_engine_storage::hex_sha256;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SET_BATCH_RECORDS: usize = 8;
pub const MAX_SET_BATCH_FIELDS: usize = 32;
pub const MAX_SET_BATCH_OPERANDS: usize = 256 * 1024;
pub const MAX_SET_BATCH_RECEIPT: usize = 1024 * 1024;
pub const MAX_SET_BATCH_STATE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchKey {
    pub claim_id: String,
    pub key_seed: String,
    pub step: u32,
    pub batch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchField {
    pub field: String,
    pub before: Value,
    pub after: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchRecord {
    pub collection_id: String,
    pub record_id: String,
    pub fields: Vec<SetBatchField>,
    pub binding: Option<SetBatchBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchBinding {
    pub object_id: String,
    pub lineage_claim_id: Option<String>,
    pub restore_generation: Option<i64>,
    pub schema_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchPlan {
    pub key: SetBatchKey,
    pub version_id: String,
    pub records: Vec<SetBatchRecord>,
}

impl SetBatchPlan {
    pub fn digest(&self) -> Result<String, DomainError> {
        // Value sorts object keys, so serialization does not depend on struct layout.
        let value = serde_json::to_value(self).map_err(|_| DomainError::StateCorrupt {
            reason: "set batch did not serialize",
        })?;
        Ok(hex_sha256(&serde_json::to_vec(&value).map_err(|_| {
            DomainError::StateCorrupt {
                reason: "set batch did not serialize",
            }
        })?))
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        self.key.validate()?;
        if self.records.is_empty()
            || self.records.len() > MAX_SET_BATCH_RECORDS
            || self
                .records
                .iter()
                .map(|record| record.fields.len())
                .sum::<usize>()
                > MAX_SET_BATCH_FIELDS
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > MAX_SET_BATCH_OPERANDS)
        {
            return Err(DomainError::InvalidInput {
                reason: "automation-set-batch-oversized",
            });
        }
        let mut records = std::collections::HashSet::new();
        for record in &self.records {
            if !records.insert((&record.collection_id, &record.record_id)) {
                return Err(DomainError::InvalidInput {
                    reason: "automation-set-batch-invalid",
                });
            }
            let mut names = std::collections::HashSet::new();
            if record.fields.is_empty()
                || record.collection_id.is_empty()
                || record.record_id.is_empty()
            {
                return Err(DomainError::InvalidInput {
                    reason: "automation-set-batch-invalid",
                });
            }
            for field in &record.fields {
                if field.field.is_empty()
                    || field.field == "id"
                    || !names.insert(&field.field)
                    || crate::collection_value_exceeds_depth(
                        &field.after,
                        crate::MAX_COLLECTION_FIELD_VALUE_DEPTH,
                    )
                {
                    return Err(DomainError::InvalidInput {
                        reason: "automation-set-batch-field-invalid",
                    });
                }
            }
        }
        Ok(())
    }
}

impl SetBatchKey {
    pub fn validate(&self) -> Result<(), DomainError> {
        if [&self.claim_id, &self.key_seed, &self.batch]
            .iter()
            .any(|id| id.is_empty() || id.len() > 512 || id.contains('\0'))
        {
            return Err(DomainError::InvalidInput {
                reason: "automation-set-batch-key-invalid",
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum SetBatchFieldOutcome {
    Changed {
        field: String,
        before: Value,
        after: Value,
        #[serde(rename = "historyId")]
        history_id: i64,
    },
    Kept {
        field: String,
        current: Value,
    },
    Unchanged {
        field: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchRecordOutcome {
    pub record_id: String,
    pub path: Option<String>,
    pub fields: Vec<SetBatchFieldOutcome>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBatchReceipt {
    pub key: SetBatchKey,
    pub digest: String,
    pub version_id: String,
    pub attribution: ChangeAttribution,
    pub records: Vec<SetBatchRecordOutcome>,
    pub jobs: Vec<String>,
    pub committed_at_ms: i64,
    pub writer_ms: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SetBatchLookup {
    Committed { receipt: SetBatchReceipt },
    Abandoned,
    Retired,
}

pub fn admitted_set_claim(
    conn: &Connection,
    workspace_id: &str,
    key: &SetBatchKey,
) -> Result<Option<String>, DomainError> {
    key.validate()?;
    conn.query_row("SELECT automation_id FROM automation_claims WHERE workspace_id=?1 AND claim_id=?2 AND expired=0",
        params![workspace_id, key.claim_id], |row| row.get(0)).optional().map_err(DomainError::sql_corrupt)
}

pub fn read_set_receipt_in_tx(
    conn: &Connection,
    workspace_id: &str,
    key: &SetBatchKey,
    digest: &str,
) -> Result<Option<SetBatchLookup>, DomainError> {
    if admitted_set_claim(conn, workspace_id, key)?.is_none() {
        return Ok(Some(SetBatchLookup::Retired));
    }
    let row: Option<(String, Option<String>)> = conn.query_row(
        "SELECT digest,receipt_json FROM automation_set_batch_receipts WHERE workspace_id=?1 AND claim_id=?2 AND key_seed=?3 AND step=?4 AND batch=?5",
        params![workspace_id, key.claim_id, key.key_seed, key.step, key.batch], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(DomainError::sql_corrupt)?;
    row.map(|(saved_digest, receipt)| {
        if saved_digest != digest {
            return Err(DomainError::InvalidInput {
                reason: "automation-set-batch-key-reused",
            });
        }
        match receipt {
            Some(receipt) => Ok(SetBatchLookup::Committed {
                receipt: serde_json::from_str(&receipt).map_err(|_| DomainError::StateCorrupt {
                    reason: "set receipt is unreadable",
                })?,
            }),
            None => Ok(SetBatchLookup::Abandoned),
        }
    })
    .transpose()
}

pub fn fence_set_receipt_in_tx(
    conn: &Connection,
    workspace_id: &str,
    key: &SetBatchKey,
    digest: &str,
    now_ms: i64,
) -> Result<SetBatchLookup, DomainError> {
    if let Some(receipt) = read_set_receipt_in_tx(conn, workspace_id, key, digest)? {
        return Ok(receipt);
    }
    conn.execute("INSERT INTO automation_set_batch_receipts(workspace_id,claim_id,key_seed,step,batch,digest,receipt_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7)",
        params![workspace_id, key.claim_id, key.key_seed, key.step, key.batch, digest, now_ms]).map_err(DomainError::sql_persist)?;
    Ok(SetBatchLookup::Abandoned)
}

pub fn save_set_receipt_in_tx(
    conn: &Connection,
    workspace_id: &str,
    receipt: &SetBatchReceipt,
) -> Result<(), DomainError> {
    let json = serde_json::to_string(receipt).map_err(|_| DomainError::StateCorrupt {
        reason: "set receipt did not serialize",
    })?;
    if json.len() > MAX_SET_BATCH_RECEIPT {
        return Err(DomainError::InvalidInput {
            reason: "automation-set-batch-oversized",
        });
    }
    conn.execute("INSERT INTO automation_set_batch_receipts(workspace_id,claim_id,key_seed,step,batch,digest,receipt_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![workspace_id, receipt.key.claim_id, receipt.key.key_seed, receipt.key.step, receipt.key.batch, receipt.digest, json, receipt.committed_at_ms]).map_err(DomainError::sql_persist)?;
    Ok(())
}
