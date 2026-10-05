//! Copy certified link rows and outstanding work without waiting for a drain.
use rusqlite::{Transaction, params};

pub fn copy_version_in_tx(
    tx: &Transaction<'_>,
    workspace: &str,
    source: &str,
    destination: &str,
) -> rusqlite::Result<()> {
    // Derived-index failure must not abort authoritative version creation.
    // Rollback restores the destination's trigger-generated full backfill.
    tx.execute_batch("SAVEPOINT link_fork_copy")?;
    let result = copy_rows(tx, workspace, source, destination);
    if result.is_err() {
        tx.execute_batch("ROLLBACK TO link_fork_copy")?;
        eprintln!("links fork copy deferred; destination backfill retained");
    }
    tx.execute_batch("RELEASE link_fork_copy")
}

fn copy_rows(
    tx: &Transaction<'_>,
    workspace: &str,
    source: &str,
    destination: &str,
) -> rusqlite::Result<()> {
    // Discard only the destination's trigger-generated obligations. Source work
    // is copied, even when certification is stale or has never been produced.
    tx.execute(
        "DELETE FROM link_pending WHERE workspace_id=?1 AND version_id=?2",
        params![workspace, destination],
    )?;
    for (table, columns) in [
        (
            "link_sources",
            "object_id,source_hash,path,title,parser_generation,status,reason,index_key,updated_at_ms,drain_latency_ms",
        ),
        (
            "links",
            "object_id,index_key,ordinal,literal,kind,fragment,start_utf16,end_utf16,line,snippet",
        ),
        (
            "link_occurrence_keys",
            "object_id,index_key,ordinal,key_kind,key",
        ),
        ("link_target_keys", "object_id,index_key,key_kind,key"),
    ] {
        let certified = if table == "link_sources" {
            String::new()
        } else {
            " AND EXISTS(SELECT 1 FROM link_sources s WHERE s.workspace_id=r.workspace_id AND s.version_id=r.version_id AND s.object_id=r.object_id AND s.index_key=r.index_key)".to_owned()
        };
        tx.execute(&format!("INSERT INTO {table}(workspace_id,version_id,{columns}) SELECT workspace_id,?2,{columns} FROM {table} r WHERE workspace_id=?1 AND version_id=?3{certified}"),params![workspace,destination,source])?;
    }
    tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,revision,queued_at_ms,retry_after_ms) SELECT workspace_id,?2,object_id,revision,queued_at_ms,retry_after_ms FROM link_pending WHERE workspace_id=?1 AND version_id=?3",params![workspace,destination,source])?;
    tx.execute("UPDATE link_index_state SET seed_after_object_id=(SELECT seed_after_object_id FROM link_index_state WHERE workspace_id=?1 AND version_id=?3), parser_generation=(SELECT parser_generation FROM link_index_state WHERE workspace_id=?1 AND version_id=?3) WHERE workspace_id=?1 AND version_id=?2 AND EXISTS(SELECT 1 FROM link_index_state WHERE workspace_id=?1 AND version_id=?3)",params![workspace,destination,source])?;
    Ok(())
}
