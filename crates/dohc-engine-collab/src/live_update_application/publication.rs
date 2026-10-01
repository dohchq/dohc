use super::*;

/// Reconstruct only native accepted history. No host handle or authority escapes.
pub(crate) fn read_native_accepted_in(
    conn: &Connection,
    key: &DocKey,
    remaining: &mut usize,
) -> Result<Option<(LiveObjectBinding, String, crate::Ydoc)>, ApplicationError> {
    let Some(held) = registration_in(conn, key)? else {
        return Ok(None);
    };
    sync::current(conn, &held)?;
    let through = settlement::latest_receipt(conn, &held)?.map_or(0, |r| r.journal_cursor);
    let mut budget = restore_content::Budget {
        remaining: *remaining,
    };
    let result = accepted_history::read_inner(
        conn,
        &held,
        through,
        &mut budget,
        accepted_history::CHECKPOINT_EVENTS as usize,
        false,
    );
    *remaining = budget.remaining;
    let history = result?;
    Ok(Some((held.binding, held.namespace, history.doc)))
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
    let Some(held) = registration_in(conn, key)? else {
        return Ok(None);
    };
    if held.namespace != namespace || held.binding != *binding {
        return Ok(None);
    }
    sync::current(conn, &held)?;
    let b = &held.binding;
    let operation: Option<String> = conn.query_row("SELECT operation_id FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND new_generation=?6",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],|r|r.get(0)).optional().map_err(read_sql)?;
    let Some(operation) = operation else {
        return Ok(None);
    };
    let mut budget = restore_content::Budget {
        remaining: *remaining,
    };
    let result = restore_resume::replaced_head(conn, &held, &operation, &mut budget);
    *remaining = budget.remaining;
    result
}

fn registration_in(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<Registration>, ApplicationError> {
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
