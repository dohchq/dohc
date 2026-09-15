use super::*;

/// Reconstruct only native accepted history. No host handle or authority escapes.
pub(crate) fn read_native_accepted_in(
    conn: &Connection,
    key: &DocKey,
    remaining: &mut usize,
) -> Result<Option<(LiveObjectBinding, String, crate::Ydoc)>, ApplicationError> {
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
