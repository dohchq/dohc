use crate::references::{MomentRefs, VersionCreateRefs, YdocRefs, conflict_open_sides};
use crate::{ReplicationEnvelope, SyncError};
use dohc_engine_collab::{
    DocKey,
    owner_outbox::publication::{PublicationContentKind, PublicationProof, PublicationReader},
};
use dohc_engine_storage::{EngineStore, hex_sha256};
use serde::Serialize;

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
fn coordinate(value: Option<&str>) -> Result<&str, SyncError> {
    value.ok_or(SyncError::InvalidInput {
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
            let refs = YdocRefs::read(p);
            let mut c = content(
                coordinate(refs.version_id)?,
                coordinate(refs.object_id)?,
                coordinate(refs.path)?,
                coordinate(refs.update_blob_sha256)?,
                PublicationContentKind::Ydoc,
            );
            c.lineage = Some(coordinate(refs.lineage_claim_id)?.into());
            result.push(c);
        }
        "moment.append" => {
            let refs = MomentRefs::read(p);
            let version = coordinate(refs.version_id)?;
            let object = coordinate(refs.object_id)?;
            for side in refs.sides() {
                if let Some(digest) = side.named_sha256() {
                    let path = side.path.or(refs.path).ok_or(SyncError::InvalidInput {
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
            let refs = VersionCreateRefs::read(p);
            // The owner proves the source version holds what the fork copied.
            if refs.fork_snapshots.is_some_and(|rows| !rows.is_empty()) {
                let version = coordinate(refs.fork_version_id)?;
                for row in refs.snapshots() {
                    result.push(content(
                        version,
                        coordinate(row.object_id)?,
                        coordinate(row.content.path)?,
                        coordinate(row.content.blob_sha256)?,
                        PublicationContentKind::Projection,
                    ));
                }
            }
        }
        "conflict.open" => {
            for side in conflict_open_sides(p) {
                let digest = match side.text {
                    Some(text) => hex_sha256(text.as_bytes()),
                    None => coordinate(side.sha256)?.into(),
                };
                result.push(content(
                    coordinate(side.version_id)?,
                    coordinate(side.object_id)?,
                    coordinate(side.path)?,
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
        // One snapshot lets consecutive references to a document reuse its accepted read.
        let read_tx = conn.unchecked_transaction().map_err(SyncError::persist)?;
        let mut reader = PublicationReader::new(&read_tx);
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
                let allowed = reader
                    .contains(
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

#[cfg(test)]
mod reference_tests {
    use std::collections::BTreeSet;

    use serde_json::{Value, json};

    use super::{PublicationContentKind, hex_sha256, references};
    use crate::{BlobKind, ReplicationEnvelope, SyncError};

    fn op(op_kind: &str, payload: Value) -> ReplicationEnvelope {
        ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace".into(),
            origin_id: "local".into(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: op_kind.into(),
            payload,
            recorded_at_ms: 0,
        }
    }

    /// What publication proves: the version, path and digest of each reference.
    fn published(op: &ReplicationEnvelope) -> BTreeSet<(String, String, String)> {
        references(op)
            .expect("publishable references")
            .into_iter()
            .map(|content| (content.version, content.path, content.digest))
            .collect()
    }

    fn proven(items: &[(&str, &str, &str)]) -> BTreeSet<(String, String, String)> {
        items
            .iter()
            .map(|(version, path, digest)| ((*version).into(), (*path).into(), (*digest).into()))
            .collect()
    }

    /// What hydration fetches: each digest in the blob lane it is stored in.
    fn hydrated(op: &ReplicationEnvelope) -> BTreeSet<(String, BlobKind)> {
        crate::relay::collect_blob_refs(std::slice::from_ref(op))
            .expect("hydratable references")
            .into_iter()
            .flat_map(|(sha256, kinds)| kinds.into_iter().map(move |kind| (sha256.clone(), kind)))
            .collect()
    }

    #[test]
    fn publication_and_hydration_read_the_same_moment_sides() {
        let text = "a".repeat(64);
        let binary = "b".repeat(64);
        let rename = op(
            "moment.append",
            json!({
                "versionId": "main", "objectId": "object-a", "path": "docs/new.bin",
                "operation": "rename",
                "payloadBeforePath": "docs/old.bin", "payloadBeforeBlobSha256": binary,
                "payloadBeforeContentKind": "binary",
                "payloadAfterPath": "docs/new.bin", "payloadAfterBlobSha256": binary,
                "payloadAfterContentKind": "binary",
                "beforePath": "docs/old.bin", "beforeBlobSha256": binary,
                "beforeContentKind": "binary",
            }),
        );
        assert_eq!(
            published(&rename),
            proven(&[
                ("main", "docs/old.bin", &binary),
                ("main", "docs/new.bin", &binary),
            ])
        );
        assert_eq!(
            hydrated(&rename),
            BTreeSet::from([(binary.clone(), BlobKind::Binary)])
        );

        let deleted = op(
            "moment.append",
            json!({
                "versionId": "main", "objectId": "object-b", "path": "notes/a.md",
                "operation": "delete",
                "payloadBeforePath": "notes/a.md", "payloadBeforeBlobSha256": text,
                "payloadAfterPath": "notes/a.md", "payloadAfterBlobSha256": text,
                "beforePath": "notes/a.md", "beforeBlobSha256": text,
            }),
        );
        assert_eq!(
            published(&deleted),
            proven(&[("main", "notes/a.md", &text)])
        );
        assert_eq!(
            hydrated(&deleted),
            BTreeSet::from([(text.clone(), BlobKind::Text)])
        );

        // A creating write: no before side, the after path left to the
        // moment's own, and an empty before digest naming no blob.
        let write = op(
            "moment.append",
            json!({
                "versionId": "main", "objectId": "object-c", "path": "notes/b.md",
                "operation": "write",
                "payloadBeforePath": null, "payloadBeforeBlobSha256": null,
                "payloadAfterBlobSha256": text, "beforeBlobSha256": "",
            }),
        );
        assert_eq!(published(&write), proven(&[("main", "notes/b.md", &text)]));
        assert_eq!(
            hydrated(&write),
            BTreeSet::from([(text.clone(), BlobKind::Text)])
        );
    }

    #[test]
    fn a_fork_is_proven_against_its_source_version() {
        let text = "a".repeat(64);
        let binary = "b".repeat(64);
        let fork = op(
            "version.create",
            json!({
                "versionId": "fork", "forkVersionId": "main",
                "forkSnapshots": [
                    {"objectId": "object-a", "path": "a.md", "blobSha256": text},
                    {"objectId": "object-b", "path": "b.bin", "blobSha256": binary,
                     "contentKind": "binary"},
                ],
            }),
        );
        assert_eq!(
            published(&fork),
            proven(&[("main", "a.md", &text), ("main", "b.bin", &binary)])
        );
        assert_eq!(
            hydrated(&fork),
            BTreeSet::from([
                (text.clone(), BlobKind::Text),
                (binary.clone(), BlobKind::Binary),
            ])
        );

        let empty = op(
            "version.create",
            json!({"versionId": "fork", "forkSnapshots": []}),
        );
        assert!(published(&empty).is_empty());
        assert!(hydrated(&empty).is_empty());

        let sourceless = op(
            "version.create",
            json!({
                "versionId": "fork",
                "forkSnapshots": [{"objectId": "object-a", "path": "a.md", "blobSha256": text}],
            }),
        );
        assert!(matches!(
            references(&sourceless),
            Err(SyncError::InvalidInput {
                reason: "queued content coordinate is malformed"
            })
        ));
    }

    #[test]
    fn conflict_open_sides_keep_their_versions_and_blob_lanes() {
        let binary = "b".repeat(64);
        let open = op(
            "conflict.open",
            json!({
                "targetVersionId": "main", "sourceVersionId": "peer",
                "base": {"exists": false, "path": "a.md"},
                "current": {"exists": true, "objectId": "object-a", "path": "a.md",
                            "text": "mine"},
                "incoming": {"exists": true, "objectId": "object-a", "path": "a.bin",
                             "contentKind": "binary", "sha256": binary},
            }),
        );
        let inline = hex_sha256(b"mine");
        assert_eq!(
            published(&open),
            proven(&[("main", "a.md", &inline), ("peer", "a.bin", &binary)])
        );
        // The text side travels inline, so only the binary side is fetched.
        assert_eq!(
            hydrated(&open),
            BTreeSet::from([(binary.clone(), BlobKind::Binary)])
        );
    }

    #[test]
    fn a_ydoc_update_is_proven_with_its_lineage_and_fetched_in_the_ydoc_lane() {
        let update = "a".repeat(64);
        let claim = "c".repeat(64);
        let ydoc = op(
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "object-a", "path": "notes/a.md",
                "updateBlobSha256": update, "lineageClaimId": claim,
            }),
        );
        let published = references(&ydoc).expect("publishable references");
        let [content] = published.as_slice() else {
            panic!("a ydoc update names exactly one reference");
        };
        assert_eq!(content.version, "main");
        assert_eq!(content.object, "object-a");
        assert_eq!(content.path, "notes/a.md");
        assert_eq!(content.digest, update);
        assert_eq!(content.lineage.as_deref(), Some(claim.as_str()));
        assert!(matches!(content.kind, PublicationContentKind::Ydoc));
        assert_eq!(
            hydrated(&ydoc),
            BTreeSet::from([(update.clone(), BlobKind::Ydoc)])
        );

        // Without its lineage the update is not provable, but hydration still
        // fetches the blob so the applier can refuse the op durably.
        let unclaimed = op(
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "object-a", "path": "notes/a.md",
                "updateBlobSha256": update,
            }),
        );
        assert!(matches!(
            references(&unclaimed),
            Err(SyncError::InvalidInput {
                reason: "queued content coordinate is malformed"
            })
        ));
        assert_eq!(
            hydrated(&unclaimed),
            BTreeSet::from([(update.clone(), BlobKind::Ydoc)])
        );
    }

    #[test]
    fn hydration_stays_lenient_where_publication_refuses() {
        let text = "a".repeat(64);
        // The applier refuses this durably, so hydration must not wedge the
        // pull on it. Publication refuses to prove it.
        let objectless = op(
            "moment.append",
            json!({
                "versionId": "main", "path": "a.md",
                "payloadAfterBlobSha256": text, "payloadAfterContentKind": 7,
            }),
        );
        assert_eq!(
            hydrated(&objectless),
            BTreeSet::from([(text.clone(), BlobKind::Text)])
        );
        assert!(matches!(
            references(&objectless),
            Err(SyncError::InvalidInput {
                reason: "queued content coordinate is malformed"
            })
        ));

        let pathless = op(
            "moment.append",
            json!({"versionId": "main", "objectId": "object-a", "payloadAfterBlobSha256": text}),
        );
        assert!(matches!(
            references(&pathless),
            Err(SyncError::InvalidInput {
                reason: "queued moment path is absent"
            })
        ));
    }
}
