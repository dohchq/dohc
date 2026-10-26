use super::*;
use restore_content::Budget;

/// Reconstruct only native accepted history. No host handle or authority escapes.
pub(crate) fn read_native_accepted_in(
    conn: &Connection,
    key: &DocKey,
    remaining: &mut usize,
) -> Result<Option<(LiveObjectBinding, String, crate::Ydoc)>, ApplicationError> {
    let mut budget = Budget {
        remaining: *remaining,
    };
    let result = native_accepted(conn, key, &mut budget);
    *remaining = budget.remaining;
    result.map(|read| read.map(|(held, doc)| (held.binding, held.namespace, doc)))
}

/// The accepted state through the last applied cursor of `binding`'s lineage
/// and that cursor, while its document's application registration, live or
/// not, is still on that lineage and restore generation: accepted history is
/// durable. Rebuilt record by record under `policy`. An applied update still
/// waiting on a missing dependency refuses the read as
/// [`AcceptedStateIncomplete`](ApplicationError::AcceptedStateIncomplete).
pub(crate) fn read_native_accepted_cut_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    policy: NativeHistoryReconstruction,
) -> Result<Option<(i64, crate::Ydoc)>, ApplicationError> {
    let Some((held, through)) = applied_cursor(conn, binding)? else {
        return Ok(None);
    };
    let doc = accepted_history::read_state(conn, &held, through, policy)?;
    Ok(Some((through, doc)))
}

/// That cursor alone, without rebuilding any state.
pub(crate) fn read_native_applied_cursor_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<i64>, ApplicationError> {
    Ok(applied_cursor(conn, binding)?.map(|(_, through)| through))
}

fn applied_cursor(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<(Registration, i64)>, ApplicationError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let mut budget = Budget {
        remaining: usize::MAX,
    };
    let Some(held) = registration_in(conn, &key, &mut budget)?.filter(|held| {
        held.binding.lineage_claim_id == binding.lineage_claim_id
            && held.binding.restore_fence_generation == binding.restore_fence_generation
    }) else {
        return Ok(None);
    };
    let through = settlement::latest_receipt(conn, &held)?.map_or(0, |r| r.journal_cursor);
    Ok(Some((held, through)))
}

fn native_accepted(
    conn: &Connection,
    key: &DocKey,
    budget: &mut Budget,
) -> Result<Option<(Registration, crate::Ydoc)>, ApplicationError> {
    let Some(held) = registration_in(conn, key, budget)? else {
        return Ok(None);
    };
    current_in(conn, &held, budget)?;
    let through =
        settlement::latest_receipt_in(conn, &held, budget)?.map_or(0, |r| r.journal_cursor);
    let history = accepted_history::read_inner(
        conn,
        &held,
        through,
        budget,
        accepted_history::CHECKPOINT_EVENTS as usize,
        accepted_history::HistoryPurpose::Native,
    )?;
    Ok(Some((held, history.doc)))
}

/// The accepted projection at this binding's original owner handover.
pub(crate) fn read_adoption_predecessor_in(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
    remaining: &mut usize,
) -> Result<Option<String>, ApplicationError> {
    let mut budget = Budget {
        remaining: *remaining,
    };
    let result = (|| {
        let cursor: Option<i64> = conn.query_row(
            "SELECT terminal_cursor FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND binding_json=?6 AND terminal_cursor>0",
            params![namespace, key.workspace_id, key.version_id, key.object_id, binding.lineage_claim_id,
                serde_json::to_string(binding).map_err(|_| ApplicationError::Corrupt)?],
            |row| row.get(0),
        ).optional().map_err(read_sql)?;
        let Some(cursor) = cursor else {
            return Ok(None);
        };
        let Some(held) = registration_in(conn, key, &mut budget)? else {
            return Ok(None);
        };
        if held.namespace != namespace || held.binding != *binding {
            return Ok(None);
        }
        current_in(conn, &held, &mut budget)?;
        let history = accepted_history::read_inner(
            conn,
            &held,
            cursor,
            &mut budget,
            accepted_history::CHECKPOINT_EVENTS as usize,
            accepted_history::HistoryPurpose::Native,
        )?;
        Ok(Some(hex_sha256(
            history
                .doc
                .project(crate::ContentKind::Richdoc)?
                .content
                .as_bytes(),
        )))
    })();
    *remaining = budget.remaining;
    result
}

/// The accepted head that the restore producing this exact binding replaced,
/// from that restore's verified resume evidence. None when the current
/// generation is not a resumed restore of this registration.
pub(crate) fn read_restore_predecessor_in(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
    remaining: &mut usize,
) -> Result<Option<String>, ApplicationError> {
    let mut budget = Budget {
        remaining: *remaining,
    };
    let result = restore_predecessor(conn, key, namespace, binding, &mut budget);
    *remaining = budget.remaining;
    result
}

fn restore_predecessor(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
    budget: &mut Budget,
) -> Result<Option<String>, ApplicationError> {
    let Some(held) = registration_in(conn, key, budget)? else {
        return Ok(None);
    };
    if held.namespace != namespace || held.binding != *binding {
        return Ok(None);
    }
    current_in(conn, &held, budget)?;
    let b = &held.binding;
    let generation = "FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND new_generation=?6";
    let p = params![
        held.namespace,
        b.workspace_id,
        b.main_version_id,
        b.object_id,
        b.lineage_claim_id,
        b.restore_fence_generation
    ];
    let length: i64 = conn
        .query_row(
            &format!("SELECT coalesce(sum(length(CAST(operation_id AS BLOB))),0) {generation}"),
            p,
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let operation: Option<String> = conn
        .query_row(&format!("SELECT operation_id {generation}"), p, |r| {
            r.get(0)
        })
        .optional()
        .map_err(read_sql)?;
    let Some(operation) = operation else {
        return Ok(None);
    };
    restore_resume::replaced_head(conn, &held, &operation, budget)
}

/// The restore registration check, charged to a publication proof's budget.
pub(crate) fn require_restore_registration_in(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
    remaining: &mut usize,
) -> Result<(), ApplicationError> {
    let mut budget = Budget {
        remaining: *remaining,
    };
    let result = charge_sql(
        conn,
        &mut budget,
        &format!(
            "SELECT {}",
            fence_registration("workspace_id=?1 AND main_version_id=?2 AND object_id=?3")
        ),
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .and_then(|()| restore_fence::require_registration(conn, key, namespace, binding));
    *remaining = budget.remaining;
    result
}

/// The text restore_fence::require_registration reads from the document's newest fence.
fn fence_registration(document: &str) -> String {
    format!("coalesce((SELECT length(CAST(relay_database_namespace AS BLOB))+coalesce(length(CAST(resume_receipt_json AS BLOB)),0) FROM live_restore_fences WHERE {document} ORDER BY new_generation DESC LIMIT 1),0)")
}

fn charge_sql(
    conn: &Connection,
    budget: &mut Budget,
    sql: &str,
    parameters: &[&dyn rusqlite::ToSql],
) -> Result<(), ApplicationError> {
    let length: i64 = conn
        .query_row(sql, parameters, |r| r.get(0))
        .map_err(read_sql)?;
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)
}

/// `sync::current` after charging the raw text it reads: the workspace's main
/// version, this registration's binding row, the newest restore fence, and
/// the durable marker.
fn current_in(
    conn: &Connection,
    held: &Registration,
    budget: &mut Budget,
) -> Result<(), ApplicationError> {
    let b = &held.binding;
    let fence = fence_registration("workspace_id=?2 AND main_version_id=?3 AND object_id=?4");
    charge_sql(conn, budget, &format!("SELECT coalesce((SELECT length(CAST(main_version_id AS BLOB)) FROM versioned_workspaces WHERE workspace_id=?2),0)
        +coalesce((SELECT length(CAST(lineage_claim_id AS BLOB))+length(CAST(current_path AS BLOB))+length(CAST(selector_paths_json AS BLOB))+length(CAST(host_id AS BLOB))+length(CAST(instance_id AS BLOB))+length(CAST(connection_id AS BLOB)) FROM live_device_application_bindings WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4),0)
        +{fence}
        +coalesce((SELECT coalesce(length(CAST(content_kind AS BLOB)),0)+coalesce(length(CAST(regime AS BLOB)),0)+coalesce(length(CAST(lineage_claim_status AS BLOB)),0)+coalesce(length(CAST(lineage_claim_id AS BLOB)),0)+coalesce(length(CAST(lineage_parent_claim_id AS BLOB)),0)+coalesce(length(CAST(lineage_epoch_tag AS BLOB)),0)+coalesce(length(CAST(path AS BLOB)),0)+coalesce(length(CAST(base_origin_id AS BLOB)),0) FROM ydoc_docs WHERE workspace_id=?2 AND version_id=?3 AND object_id=?4),0)"),
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id])?;
    sync::current(conn, held).map(|_| ())
}

/// One binding row per relay namespace; up to two rows are read to detect a conflict.
fn registration_in(
    conn: &Connection,
    key: &DocKey,
    budget: &mut Budget,
) -> Result<Option<Registration>, ApplicationError> {
    charge_sql(conn, budget, "SELECT coalesce(sum(n),0) FROM (SELECT length(CAST(relay_database_namespace AS BLOB))+length(CAST(lineage_claim_id AS BLOB))+length(CAST(current_path AS BLOB))+length(CAST(selector_paths_json AS BLOB))+length(CAST(host_id AS BLOB))+length(CAST(instance_id AS BLOB))+length(CAST(connection_id AS BLOB)) AS n FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 LIMIT 2)",
        params![key.workspace_id, key.version_id, key.object_id])?;
    let mut query = conn.prepare("SELECT relay_database_namespace,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 LIMIT 2").map_err(read_sql)?;
    let records = query
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |row| {
                let selectors: String = row.get(3)?;
                Ok(Registration {
                    namespace: row.get(0)?,
                    workspace_id: key.workspace_id.clone(),
                    binding: LiveObjectBinding {
                        workspace_id: key.workspace_id.clone(),
                        main_version_id: key.version_id.clone(),
                        object_id: key.object_id.clone(),
                        lineage_claim_id: row.get(1)?,
                        current_path: row.get(2)?,
                        selector_paths: serde_json::from_str(&selectors).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?,
                        restore_fence_generation: row.get(4)?,
                    },
                    coordinate: ApplicationHostCoordinate {
                        host_id: row.get(5)?,
                        host_epoch: row.get(6)?,
                        instance_id: row.get(7)?,
                        connection_id: row.get(8)?,
                    },
                    live: row.get::<_, i64>(9)? == 1,
                })
            },
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    if records.len() > 1 {
        return Err(ApplicationError::Conflict);
    }
    let Some(held) = records.into_iter().next() else {
        return Ok(None);
    };
    held.binding.validate_canonical().map_err(invalid)?;
    held.coordinate.validate()?;
    Ok(Some(held))
}
