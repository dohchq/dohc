use rusqlite::{OptionalExtension, Transaction, params};

use crate::SyncError;

use crate::conflict_resolve_v1::{
    BuiltConflictResolveV1, ConflictResolveEnvelopeContext, ValidatedConflictResolveV1,
    validate_conflict_resolve_v1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PendingConflictBundleCut {
    pub bundle_order: i64,
    pub pre_effect_moment_order: i64,
}

pub(crate) fn pending_conflict_bundle_cuts_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<Vec<PendingConflictBundleCut>, SyncError> {
    let mut statement = tx
        .prepare(
            "SELECT bundle_order, pre_effect_moment_order \
             FROM replication_pending_conflict_bundles \
             WHERE workspace_id=?1 \
             ORDER BY pre_effect_moment_order, bundle_order",
        )
        .map_err(SyncError::corrupt)?;
    statement
        .query_map([workspace_id], |row| {
            Ok(PendingConflictBundleCut {
                bundle_order: row.get(0)?,
                pre_effect_moment_order: row.get(1)?,
            })
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
}

/// Persist one fully validated local resolution bundle, then journal it
/// immediately when the workspace already has a relay position.
///
/// All payload bytes and blob roots are validated before the first durable
/// insert. The parent and its children still share the caller's transaction,
/// so an immediate journal failure rolls the whole reviewed resolution back.
pub(crate) fn persist_local_conflict_resolve_v1_in_tx(
    tx: &Transaction<'_>,
    built: &BuiltConflictResolveV1,
    pre_effect_moment_order: i64,
) -> Result<(), SyncError> {
    if pre_effect_moment_order < 0 {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve pre-effect moment order must be nonnegative",
        });
    }
    let expected = &built.validated.payload;
    let validated = validate_conflict_resolve_v1(
        &built.value,
        ConflictResolveEnvelopeContext {
            workspace_id: &expected.workspace_id,
            recorded_at_ms: expected.effect_context.recorded_at_ms,
        },
    )?;
    let payload_json = canonical_json(&built.value)?;
    crate::journal::validate_local_payload_json(
        &validated.payload.workspace_id,
        "conflict.resolve",
        &payload_json,
    )?;
    let shadow_json = validated
        .shadows
        .iter()
        .map(canonical_json)
        .collect::<Result<Vec<_>, _>>()?;
    for payload_json in &shadow_json {
        crate::journal::validate_local_payload_json(
            &validated.payload.workspace_id,
            "moment.append",
            payload_json,
        )?;
    }
    let binary_storage_roots = binary_storage_roots(&validated);
    ensure_roots_exist(
        tx,
        "blobs",
        &validated.text_blob_sha256s,
        "conflict.resolve text blob root is missing",
    )?;
    ensure_roots_exist(
        tx,
        "binary_blobs",
        &binary_storage_roots,
        "conflict.resolve binary or Y.Doc blob root is missing",
    )?;

    tx.execute(
        "INSERT INTO replication_pending_conflict_bundles \
         (workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) \
         VALUES (?1,?2,1,?3,?4)",
        params![
            validated.payload.workspace_id,
            validated.payload.conflict_id,
            pre_effect_moment_order,
            validated.payload.effect_context.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    let bundle_order = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO replication_pending_conflict_ops \
         (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) \
         VALUES (?1,0,'conflict.resolve',?2,?3)",
        params![
            bundle_order,
            payload_json,
            validated.payload.effect_context.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    for (effect_index, (effect, payload_json)) in validated
        .payload
        .effects
        .iter()
        .zip(shadow_json)
        .enumerate()
    {
        let op_index =
            i64::try_from(effect_index + 1).map_err(|_| SyncError::CoordinateDiverged)?;
        tx.execute(
            "INSERT INTO replication_pending_conflict_ops \
             (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) \
             VALUES (?1,?2,'moment.append',?3,?4)",
            params![
                bundle_order,
                op_index,
                payload_json,
                validated.payload.effect_context.recorded_at_ms,
            ],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "INSERT INTO replication_pending_conflict_moments \
             (workspace_id,bundle_order,op_index,moment_id) VALUES (?1,?2,?3,?4)",
            params![
                validated.payload.workspace_id,
                bundle_order,
                op_index,
                effect.moment_id,
            ],
        )
        .map_err(SyncError::persist)?;
    }
    insert_roots(
        tx,
        "replication_pending_conflict_text_blobs",
        bundle_order,
        &validated.text_blob_sha256s,
    )?;
    insert_roots(
        tx,
        "replication_pending_conflict_binary_blobs",
        bundle_order,
        &binary_storage_roots,
    )?;

    if crate::workspace_replicates_with_relay_in_tx(tx, &validated.payload.workspace_id)? {
        journal_pending_conflict_bundle_in_tx(tx, &validated.payload.workspace_id, bundle_order)?;
    }
    Ok(())
}

fn binary_storage_roots(validated: &ValidatedConflictResolveV1) -> Vec<String> {
    validated
        .binary_blob_sha256s
        .iter()
        .chain(&validated.ydoc_blob_sha256s)
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn canonical_json(value: &serde_json::Value) -> Result<String, SyncError> {
    String::from_utf8(crate::relay::canonical_json_bytes(value)?).map_err(|_| {
        SyncError::InvalidInput {
            reason: "canonical replication payload is not UTF-8",
        }
    })
}

fn ensure_roots_exist(
    tx: &Transaction<'_>,
    table: &str,
    roots: &[String],
    reason: &'static str,
) -> Result<(), SyncError> {
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE sha256=?1)");
    for sha256 in roots {
        let exists: bool = tx
            .query_row(&sql, [sha256], |row| row.get(0))
            .map_err(SyncError::corrupt)?;
        if !exists {
            return Err(SyncError::InvalidInput { reason });
        }
    }
    Ok(())
}

fn insert_roots(
    tx: &Transaction<'_>,
    table: &str,
    bundle_order: i64,
    roots: &[String],
) -> Result<(), SyncError> {
    let sql = format!("INSERT INTO {table} (bundle_order,blob_sha256) VALUES (?1,?2)");
    for sha256 in roots {
        tx.execute(&sql, params![bundle_order, sha256])
            .map_err(SyncError::persist)?;
    }
    Ok(())
}

pub(crate) fn journal_pending_conflict_bundle_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    bundle_order: i64,
) -> Result<(), SyncError> {
    let parent: Option<(String, i64)> = tx
        .query_row(
            "SELECT conflict_id, format_version \
             FROM replication_pending_conflict_bundles \
             WHERE workspace_id=?1 AND bundle_order=?2",
            params![workspace_id, bundle_order],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((conflict_id, format_version)) = parent else {
        return Err(corrupt_bundle(
            bundle_order,
            "pending conflict bundle parent is missing",
        ));
    };
    if format_version != 1 {
        return Err(corrupt_bundle(
            bundle_order,
            "pending conflict bundle formatVersion is not 1",
        ));
    }

    let mut statement = tx
        .prepare(
            "SELECT op_index, op_kind, payload_json, recorded_at_ms \
             FROM replication_pending_conflict_ops \
             WHERE bundle_order=?1 ORDER BY op_index",
        )
        .map_err(SyncError::corrupt)?;
    let operations = statement
        .query_map([bundle_order], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    if operations.is_empty() || operations.len() > 3 {
        return Err(corrupt_bundle(
            bundle_order,
            "pending conflict bundle must contain one resolve and at most two moment shadows",
        ));
    }
    for (offset, (op_index, op_kind, payload_json, _)) in operations.iter().enumerate() {
        let expected_index = i64::try_from(offset).expect("three operations fit in i64");
        if *op_index != expected_index {
            return Err(corrupt_bundle(
                bundle_order,
                "pending conflict bundle operation indexes are not contiguous",
            ));
        }
        let expected_kind = if expected_index == 0 {
            "conflict.resolve"
        } else {
            "moment.append"
        };
        if op_kind != expected_kind {
            return Err(corrupt_bundle(
                bundle_order,
                "pending conflict bundle operation order is invalid",
            ));
        }
        crate::journal::validate_local_payload_json(workspace_id, op_kind, payload_json)?;
        let payload: serde_json::Value = serde_json::from_str(payload_json).map_err(|_| {
            corrupt_bundle(
                bundle_order,
                "pending conflict bundle payload is invalid JSON",
            )
        })?;
        if expected_index == 0 {
            if payload
                .get("formatVersion")
                .and_then(serde_json::Value::as_i64)
                != Some(1)
                || payload
                    .get("workspaceId")
                    .and_then(serde_json::Value::as_str)
                    != Some(workspace_id)
                || payload
                    .get("conflictId")
                    .and_then(serde_json::Value::as_str)
                    != Some(conflict_id.as_str())
            {
                return Err(corrupt_bundle(
                    bundle_order,
                    "pending conflict resolve payload does not match its parent",
                ));
            }
        } else {
            let moment_id = payload
                .get("momentId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    corrupt_bundle(
                        bundle_order,
                        "pending conflict moment payload has no momentId",
                    )
                })?;
            let recorded_moment: Option<String> = tx
                .query_row(
                    "SELECT moment_id FROM replication_pending_conflict_moments \
                     WHERE workspace_id=?1 AND bundle_order=?2 AND op_index=?3",
                    params![workspace_id, bundle_order, op_index],
                    |row| row.get(0),
                )
                .optional()
                .map_err(SyncError::corrupt)?;
            if recorded_moment.as_deref() != Some(moment_id) {
                return Err(corrupt_bundle(
                    bundle_order,
                    "pending conflict moment identity does not match its payload",
                ));
            }
        }
    }
    for (_, op_kind, payload_json, recorded_at_ms) in &operations {
        crate::journal::journal_local_payload_json_in_tx(
            tx,
            workspace_id,
            op_kind,
            payload_json,
            *recorded_at_ms,
        )?;
    }

    let deleted = tx
        .execute(
            "DELETE FROM replication_pending_conflict_bundles \
             WHERE workspace_id=?1 AND bundle_order=?2",
            params![workspace_id, bundle_order],
        )
        .map_err(SyncError::persist)?;
    if deleted != 1 {
        return Err(corrupt_bundle(
            bundle_order,
            "pending conflict bundle disappeared before drain commit",
        ));
    }
    Ok(())
}

fn corrupt_bundle(bundle_order: i64, constraint: &str) -> SyncError {
    SyncError::corrupt(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("{constraint}; bundle_order={bundle_order}"),
    ))
}

#[cfg(test)]
mod tests {
    use dohc_engine_domain::VersionedTextStore;
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome, hex_sha256};
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::params;

    use super::*;
    use crate::conflict_resolve_v1::{
        BuiltConflictResolveV1, ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1,
        HeadContentKindV1, HeadV1, LineageTransitionV1, MetadataV1, PresentHeadV1, ResolutionV1,
        ResolveChoiceV1, SuccessorContentKindV1, SuccessorV1, build_conflict_resolve_v1,
    };

    fn store() -> (ScratchDir, EngineStore) {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("main version");
        let outcome = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_identity \
                     (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                     VALUES ('ws','local','epoch','stream',1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed identity");
        assert!(matches!(outcome, TxnOutcome::Committed(())));
        (scratch, store)
    }

    fn carrier(store: &mut EngineStore) -> BuiltConflictResolveV1 {
        let current = "current";
        let result = "result";
        let successor_update = b"successor-ydoc-base";
        let successor_state_vector = b"successor-state-vector";
        let current_sha = hex_sha256(current.as_bytes());
        let result_sha = hex_sha256(result.as_bytes());
        let successor_sha = hex_sha256(successor_update);
        let state_vector_sha = hex_sha256(successor_state_vector);
        let outcome = store
            .write_with(&NoFaults, |tx| {
                for (sha, text) in [(&current_sha, current), (&result_sha, result)] {
                    tx.execute(
                        "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                        params![sha, i64::try_from(text.len()).unwrap(), text],
                    )
                    .map_err(SyncError::persist)?;
                }
                dohc_engine_storage::put_binary_blob(tx, successor_update)
                    .map_err(SyncError::Storage)?;
                dohc_engine_storage::put_binary_blob(tx, successor_state_vector)
                    .map_err(SyncError::Storage)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed carrier roots");
        assert!(matches!(outcome, TxnOutcome::Committed(())));

        build_conflict_resolve_v1(ConflictResolveV1 {
            workspace_id: "ws".to_owned(),
            conflict_id: "conflict-1".to_owned(),
            chosen_from: ResolveChoiceV1::Incoming,
            resolution: ResolutionV1::AppliedIncoming,
            target_version_id: "main".to_owned(),
            source_version_id: "peer-main".to_owned(),
            paths: vec!["doc.md".to_owned()],
            current: HeadV1::Present(PresentHeadV1 {
                path_ref: 0,
                object_id: "object-1".to_owned(),
                latest_moment_id: "moment-current".to_owned(),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: current_sha.clone(),
                byte_length: i64::try_from(current.len()).unwrap(),
                updated_at_ms: 10,
            }),
            incoming: HeadV1::Present(PresentHeadV1 {
                path_ref: 0,
                object_id: "object-1".to_owned(),
                latest_moment_id: "moment-incoming".to_owned(),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: result_sha.clone(),
                byte_length: i64::try_from(result.len()).unwrap(),
                updated_at_ms: 20,
            }),
            result: HeadV1::Present(PresentHeadV1 {
                path_ref: 0,
                object_id: "object-1".to_owned(),
                latest_moment_id: "moment-result".to_owned(),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: result_sha.clone(),
                byte_length: i64::try_from(result.len()).unwrap(),
                updated_at_ms: 30,
            }),
            effect_context: EffectContextV1 {
                recorded_at_ms: 30,
                metadata: MetadataV1 {
                    origin: "api".to_owned(),
                    summary: Some("reviewed choice".to_owned()),
                    correlation_id: Some("correlation-1".to_owned()),
                },
                author: None,
                current_object_created_at_ms: Some(1),
                result_object_created_at_ms: Some(1),
            },
            effects: vec![EffectV1 {
                kind: EffectKindV1::Write,
                moment_id: "moment-result".to_owned(),
                payload_sha256: String::new(),
            }],
            lineage_transition: Some(LineageTransitionV1 {
                predecessor_claim_id: "e".repeat(64),
                predecessor_state_vector_sha256: "f".repeat(64),
                artifact_preimage_sha256: current_sha,
                successor: Some(SuccessorV1 {
                    lineage_claim_id: successor_sha.clone(),
                    epoch_tag: "1".repeat(64),
                    content_kind: SuccessorContentKindV1::Plaintext,
                    result_sha256: result_sha,
                    update_blob_sha256: successor_sha,
                    state_vector_blob_sha256: state_vector_sha,
                }),
            }),
        })
        .expect("build v1 carrier")
    }

    fn canonical(value: &serde_json::Value) -> String {
        String::from_utf8(crate::relay::canonical_json_bytes(value).expect("canonical JSON"))
            .expect("canonical JSON is UTF-8")
    }

    fn state_fingerprint(store: &EngineStore) -> (i64, i64, i64, i64, i64, i64, i64) {
        store
            .read_with(|conn| {
                let count = |table: &str| {
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })
                };
                Ok::<_, rusqlite::Error>((
                    count("replication_pending_conflict_bundles")?,
                    count("replication_pending_conflict_ops")?,
                    count("replication_pending_conflict_moments")?,
                    count("replication_pending_conflict_text_blobs")?,
                    count("replication_pending_conflict_binary_blobs")?,
                    count("replication_log")?,
                    conn.query_row(
                        "SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log \
                         WHERE workspace_id='ws' AND origin_id='local'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("state fingerprint")
    }

    #[test]
    fn typed_enqueue_persists_exact_carrier_shadows_and_fk_backed_roots() {
        let (_scratch, mut store) = store();
        let built = carrier(&mut store);
        let outer = canonical(&built.value);
        let shadow = canonical(&built.validated.shadows[0]);

        let outcome = store
            .write_with(&NoFaults, |tx| {
                persist_local_conflict_resolve_v1_in_tx(tx, &built, 7)
            })
            .expect("persist unpositioned bundle");
        assert!(matches!(outcome, TxnOutcome::Committed(())));

        let (ops, moments, text_roots, binary_roots, log_count) = store
            .read_with(|conn| {
                let ops = conn
                    .prepare(
                        "SELECT op_kind,payload_json,recorded_at_ms \
                         FROM replication_pending_conflict_ops ORDER BY op_index",
                    )?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let moments = conn
                    .prepare(
                        "SELECT op_index,moment_id FROM replication_pending_conflict_moments \
                         ORDER BY op_index",
                    )?
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let roots = |table: &str| -> rusqlite::Result<Vec<String>> {
                    conn.prepare(&format!(
                        "SELECT blob_sha256 FROM {table} ORDER BY blob_sha256"
                    ))?
                    .query_map([], |row| row.get(0))?
                    .collect()
                };
                Ok::<_, rusqlite::Error>((
                    ops,
                    moments,
                    roots("replication_pending_conflict_text_blobs")?,
                    roots("replication_pending_conflict_binary_blobs")?,
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("inspect pending bundle");
        assert_eq!(
            ops,
            vec![
                ("conflict.resolve".to_owned(), outer, 30),
                ("moment.append".to_owned(), shadow, 30),
            ]
        );
        assert_eq!(moments, vec![(1, "moment-result".to_owned())]);
        assert_eq!(text_roots, built.validated.text_blob_sha256s);
        assert_eq!(binary_roots, binary_storage_roots(&built.validated));
        assert_eq!(binary_roots.len(), 2, "successor update and state vector");
        assert_eq!(log_count, 0);
    }

    #[test]
    fn typed_enqueue_preflights_before_seq_then_flushes_resolve_first_without_ydoc_echo() {
        let (_scratch, mut store) = store();
        let built = carrier(&mut store);
        let outcome = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES ('ws','local',-1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("position workspace");
        assert!(matches!(outcome, TxnOutcome::Committed(())));

        let mut invalid = built.clone();
        invalid.value["effects"][0]["payloadSha256"] = serde_json::json!("0".repeat(64));
        let before = state_fingerprint(&store);
        let error = store
            .write_with(&NoFaults, |tx| {
                persist_local_conflict_resolve_v1_in_tx(tx, &invalid, 7)
            })
            .expect_err("invalid shadow hash must fail before allocation");
        assert!(matches!(
            error,
            SyncError::InvalidInput {
                reason: "conflict.resolve effect hash does not match its canonical moment shadow"
            }
        ));
        assert_eq!(state_fingerprint(&store), before);

        let outer = canonical(&built.value);
        let shadow = canonical(&built.validated.shadows[0]);
        let outcome = store
            .write_with(&NoFaults, |tx| {
                persist_local_conflict_resolve_v1_in_tx(tx, &built, 7)
            })
            .expect("persist and flush positioned bundle");
        assert!(matches!(outcome, TxnOutcome::Committed(())));
        let rows = store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT origin_seq,op_kind,payload_json,recorded_at_ms \
                     FROM replication_log WHERE workspace_id='ws' ORDER BY origin_seq",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .expect("read flushed operations");
        assert_eq!(
            rows,
            vec![
                (0, "conflict.resolve".to_owned(), outer, 30),
                (1, "moment.append".to_owned(), shadow, 30),
            ]
        );
        assert_eq!(state_fingerprint(&store), (0, 0, 0, 0, 0, 2, 1));
        assert!(rows.iter().all(|(_, kind, _, _)| kind != "ydoc.update"));
    }
}
