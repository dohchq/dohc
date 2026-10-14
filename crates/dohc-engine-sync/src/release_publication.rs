use crate::{
    RefusalReason, ReplicationEnvelope, ReplicationRefusal, SettlementAdmission, SyncError,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

pub(crate) const MESSAGE: &str = "dohc did not share this edit.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleasePublicationRefusal {
    pub origin_id: String,
    pub origin_seq: i64,
    pub status: String,
    pub kind: String,
    pub release_digest: String,
    pub reason: String,
}

fn invalid() -> SyncError {
    SyncError::InvalidInput {
        reason: "invalid release publication refusal",
    }
}
fn digest(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub(crate) fn validate(
    op: &ReplicationEnvelope,
    release_digest: &str,
    reason: &str,
) -> Result<(), SyncError> {
    let tag = &op.payload["release"];
    let document = &tag["document"];
    let fields = |v: &serde_json::Value, names: &[&str]| {
        v.as_object()
            .is_some_and(|o| o.len() == names.len() && names.iter().all(|n| o.contains_key(*n)))
    };
    if op.relay_seq.is_none()
        || op.admitted_author_snapshot.is_some()
        || !matches!(
            reason,
            "release-publication-fenced"
                | "release-generation-fenced"
                | "release-restore-in-progress"
                | "release-document-changed"
        )
        || !fields(
            tag,
            &["releaseDigest", "restoreFenceGeneration", "document"],
        )
        || !fields(
            document,
            &["workspaceId", "mainVersionId", "objectId", "lineageClaimId"],
        )
        || !digest(&tag["releaseDigest"])
        || tag["releaseDigest"].as_str() != Some(release_digest)
        || !digest(&document["lineageClaimId"])
        || !tag["restoreFenceGeneration"]
            .as_i64()
            .is_some_and(|n| (0..=crate::MAX_WIRE_INTEGER).contains(&n))
        || document["workspaceId"].as_str() != Some(&op.workspace_id)
        || document["mainVersionId"] != "main"
        || op.payload["versionId"] != document["mainVersionId"]
        || op.payload["objectId"] != document["objectId"]
        || !document["objectId"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 512)
    {
        return Err(invalid());
    }
    let path = op.payload["path"].as_str().ok_or_else(invalid)?;
    dohc_engine_domain::validate_plaintext_storable_path(path).map_err(|_| invalid())?;
    match op.op_kind.as_str() {
        "ydoc.update"
            if op.payload["lineageClaimId"] == document["lineageClaimId"]
                && op.payload["contentKind"] == "richdoc"
                && op.payload["isBaseState"].is_boolean()
                && digest(&op.payload["updateBlobSha256"]) =>
        {
            Ok(())
        }
        "moment.append"
            if op.payload["operation"] == "write"
                && op.payload["payloadAfterContentKind"] == "text"
                && op.payload["payloadAfterPath"] == op.payload["path"]
                && digest(&op.payload["payloadAfterBlobSha256"])
                && op.payload.get("authors").is_none()
                && op.payload["momentId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                && op.payload["payloadAfterByteLength"]
                    .as_i64()
                    .is_some_and(|n| (0..=crate::MAX_WIRE_INTEGER).contains(&n)) =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}

pub(crate) fn refusal(op: &ReplicationEnvelope) -> ReplicationRefusal {
    ReplicationRefusal {
        workspace_id: op.workspace_id.clone(),
        origin_id: op.origin_id.clone(),
        origin_seq: op.origin_seq,
        op_kind: op.op_kind.clone(),
        reason: RefusalReason::InvalidInput {
            reason: MESSAGE.into(),
        },
    }
}

pub(crate) fn refresh_in_tx(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    release_digest: &str,
    reason: &str,
) -> Result<ReplicationRefusal, SyncError> {
    validate(op, release_digest, reason)?;
    let previous: Option<(String, String, String)> = tx.query_row("SELECT op_kind,release_digest,reason FROM release_publication_admissions WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![op.workspace_id, op.origin_id, op.origin_seq], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(SyncError::corrupt)?;
    if previous.is_some_and(|p| p != (op.op_kind.clone(), release_digest.into(), reason.into())) {
        return Err(SyncError::CoordinateDiverged);
    }
    tx.execute("INSERT INTO release_publication_admissions VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING", params![op.workspace_id,op.origin_id,op.origin_seq,op.op_kind,release_digest,reason]).map_err(SyncError::persist)?;
    let result = refusal(op);
    tx.execute("INSERT INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) VALUES (?1,?2,?3,?4,'invalid-input',?5) ON CONFLICT DO NOTHING",params![op.workspace_id,op.origin_id,op.origin_seq,op.op_kind,MESSAGE]).map_err(SyncError::persist)?;
    tx.execute("UPDATE replication_log SET apply_disposition='refused' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq]).map_err(SyncError::persist)?;
    Ok(result)
}

pub(crate) fn validate_push_refusals(
    refusals: &[ReleasePublicationRefusal],
    batch: &[ReplicationEnvelope],
) -> Result<(), crate::RelayError> {
    let mut seen = std::collections::BTreeSet::new();
    for refusal in refusals {
        let Some(original) = batch
            .iter()
            .find(|op| op.origin_id == refusal.origin_id && op.origin_seq == refusal.origin_seq)
        else {
            return Err(crate::RelayError::InvalidResponse);
        };
        let mut op = original.clone();
        op.relay_seq = Some(0);
        if refusal.status != "refused"
            || refusal.kind != "release-publication"
            || !seen.insert((&refusal.origin_id, refusal.origin_seq))
            || validate(&op, &refusal.release_digest, &refusal.reason).is_err()
        {
            return Err(crate::RelayError::InvalidResponse);
        }
    }
    Ok(())
}

pub(crate) fn push_refusals_in_tx(
    tx: &Transaction<'_>,
    workspace: &str,
    refusals: &[ReleasePublicationRefusal],
) -> Result<(), SyncError> {
    for refusal in refusals {
        let (kind,json,recorded): (String,String,i64) = tx.query_row("SELECT op_kind,payload_json,recorded_at_ms FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND imported=0",params![workspace,refusal.origin_id,refusal.origin_seq],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(SyncError::corrupt)?;
        let op = ReplicationEnvelope {
            workspace_id: workspace.into(),
            origin_id: refusal.origin_id.clone(),
            origin_seq: refusal.origin_seq,
            relay_seq: Some(0),
            op_kind: kind,
            payload: serde_json::from_str(&json).map_err(SyncError::corrupt)?,
            recorded_at_ms: recorded,
            settlement_admission: Some(SettlementAdmission::ReleaseRefused {
                release_digest: refusal.release_digest.clone(),
                reason: refusal.reason.clone(),
            }),
            admitted_author_snapshot: None,
        };
        refresh_in_tx(tx, &op, &refusal.release_digest, &refusal.reason)?;
    }
    Ok(())
}
