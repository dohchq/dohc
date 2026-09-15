use crate::{ReplicationEnvelope, SyncError};
use dohc_engine_collab::{
    DocKey,
    owner_outbox::publication::{PublicationContentKind, PublicationProof, contains_in},
};
use dohc_engine_storage::{EngineStore, hex_sha256};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerAdmissionPending {
    pub workspace_id: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerPublicationPrefix {
    pub allowed_ops: usize,
    pub pending: Option<OwnerAdmissionPending>,
    pub budget_exhausted: bool,
}
struct Content {
    version: String,
    object: String,
    path: String,
    lineage: Option<String>,
    digest: String,
    kind: PublicationContentKind,
}
fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str, SyncError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or(SyncError::InvalidInput {
            reason: "queued content coordinate is malformed",
        })
}
fn content(
    version: &str,
    object: &str,
    path: &str,
    digest: &str,
    kind: PublicationContentKind,
) -> Content {
    Content {
        version: version.into(),
        object: object.into(),
        path: path.into(),
        lineage: None,
        digest: digest.into(),
        kind,
    }
}
fn references(op: &ReplicationEnvelope) -> Result<Vec<Content>, SyncError> {
    let p = &op.payload;
    let mut result = Vec::new();
    match op.op_kind.as_str() {
        "ydoc.update" => {
            let mut c = content(
                required(p, "versionId")?,
                required(p, "objectId")?,
                required(p, "path")?,
                required(p, "updateBlobSha256")?,
                PublicationContentKind::Ydoc,
            );
            c.lineage = Some(required(p, "lineageClaimId")?.into());
            result.push(c);
        }
        "moment.append" => {
            let version = required(p, "versionId")?;
            let object = required(p, "objectId")?;
            for (digest, path) in [
                ("payloadBeforeBlobSha256", "payloadBeforePath"),
                ("payloadAfterBlobSha256", "payloadAfterPath"),
                ("beforeBlobSha256", "beforePath"),
            ] {
                if let Some(digest) = p
                    .get(digest)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let path = p
                        .get(path)
                        .and_then(Value::as_str)
                        .or_else(|| p.get("path").and_then(Value::as_str))
                        .ok_or(SyncError::InvalidInput {
                            reason: "queued moment path is absent",
                        })?;
                    result.push(content(
                        version,
                        object,
                        path,
                        digest,
                        PublicationContentKind::Projection,
                    ));
                }
            }
        }
        "version.create" => {
            if let Some(rows) = p.get("forkSnapshots").and_then(Value::as_array) {
                if !rows.is_empty() {
                    let version = required(p, "forkVersionId")?;
                    for row in rows {
                        result.push(content(
                            version,
                            required(row, "objectId")?,
                            required(row, "path")?,
                            required(row, "blobSha256")?,
                            PublicationContentKind::Projection,
                        ));
                    }
                }
            }
        }
        "conflict.open" => {
            for (name, version) in [
                ("base", "targetVersionId"),
                ("current", "targetVersionId"),
                ("incoming", "sourceVersionId"),
            ] {
                let Some(side) = p.get(name) else {
                    continue;
                };
                if side.get("exists").and_then(Value::as_bool) != Some(true) {
                    continue;
                }
                let digest = if let Some(text) = side.get("text").and_then(Value::as_str) {
                    hex_sha256(text.as_bytes())
                } else {
                    required(side, "sha256")?.into()
                };
                result.push(content(
                    required(p, version)?,
                    required(side, "objectId")?,
                    required(side, "path")?,
                    &digest,
                    PublicationContentKind::Projection,
                ));
            }
        }
        "conflict.resolve" => {
            let checked = crate::conflict_resolve_v1::validate_conflict_resolve_v1(
                p,
                crate::conflict_resolve_v1::ConflictResolveEnvelopeContext {
                    workspace_id: &op.workspace_id,
                    recorded_at_ms: op.recorded_at_ms,
                },
            )?;
            let p = &checked.payload;
            for (head, version) in [
                (&p.current, &p.target_version_id),
                (&p.result, &p.target_version_id),
                (&p.incoming, &p.source_version_id),
            ] {
                if let Some(head) = head.present() {
                    result.push(content(
                        version,
                        &head.object_id,
                        &p.paths[head.path_ref],
                        &head.blob_sha256,
                        PublicationContentKind::Projection,
                    ));
                }
            }
            if let Some(successor) = p
                .lineage_transition
                .as_ref()
                .and_then(|transition| transition.successor.as_ref())
            {
                if let Some(result_head) = p.result.present() {
                    for digest in [
                        &successor.update_blob_sha256,
                        &successor.state_vector_blob_sha256,
                    ] {
                        result.push(content(
                            &p.target_version_id,
                            &result_head.object_id,
                            &p.paths[result_head.path_ref],
                            digest,
                            PublicationContentKind::Ydoc,
                        ));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(result)
}

/// Stop before the first private owner payload. Never rewrite the origin log.
pub fn owner_publication_prefix(
    store: &EngineStore,
    workspace: &str,
    ops: &[ReplicationEnvelope],
    max_read_bytes: usize,
) -> Result<OwnerPublicationPrefix, SyncError> {
    store.read_with(|conn| {
        let mut remaining = max_read_bytes;
        for (allowed_ops, op) in ops.iter().enumerate() {
            if op.workspace_id != workspace {
                return Err(SyncError::InvalidInput {
                    reason: "queued owner workspace differs",
                });
            }
            for reference in references(op)? {
                let key = DocKey::new(workspace, &reference.version, &reference.object).map_err(
                    |_| SyncError::InvalidInput {
                        reason: "queued owner key is malformed",
                    },
                )?;
                let allowed = contains_in(
                    conn,
                    &key,
                    &reference.path,
                    reference.lineage.as_deref(),
                    reference.kind,
                    &reference.digest,
                    &mut remaining,
                )
                .map_err(|_| {
                    crate::error::local_corruption("queued owner publication proof is invalid")
                })?;
                if allowed == PublicationProof::BudgetExhausted {
                    if allowed_ops == 0 {
                        return Err(SyncError::InvalidInput {
                            reason: "owner publication proof exceeds configured read budget",
                        });
                    }
                    return Ok(OwnerPublicationPrefix {
                        allowed_ops,
                        pending: None,
                        budget_exhausted: true,
                    });
                }
                if allowed == PublicationProof::NotContained {
                    return Ok(OwnerPublicationPrefix {
                        allowed_ops,
                        budget_exhausted: false,
                        pending: Some(OwnerAdmissionPending {
                            workspace_id: workspace.into(),
                            origin_id: op.origin_id.clone(),
                            origin_seq: op.origin_seq,
                            version_id: reference.version,
                            object_id: reference.object,
                            path: reference.path,
                        }),
                    });
                }
            }
        }
        Ok(OwnerPublicationPrefix {
            allowed_ops: ops.len(),
            budget_exhausted: false,
            pending: None,
        })
    })
}
