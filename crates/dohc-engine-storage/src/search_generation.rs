//! Connection-local revision for search content and result coordinates.

use rusqlite::{Connection, functions::FunctionFlags};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

pub(crate) fn install(conn: &Connection) -> rusqlite::Result<()> {
    let generation = Arc::new(AtomicI64::new(0));
    let dirty = Arc::new(AtomicBool::new(false));
    let writes = Arc::clone(&dirty);
    let hold_generation = Arc::new(AtomicI64::new(0));
    let hold_writes = Arc::clone(&hold_generation);
    conn.update_hook(Some(move |_, database: &str, table: &str, _| {
        #[cfg(feature = "fault-injection")]
        {
            crate::capture_phase::count("row_hook_callbacks", 1);
            match table {
                "link_pending" => crate::capture_phase::count("link_pending_row_writes", 1),
                "link_aliases" => crate::capture_phase::count("link_alias_row_writes", 1),
                "links" | "link_sources" | "link_target_keys" | "link_occurrence_keys" => {
                    crate::capture_phase::count("link_index_row_writes", 1)
                }
                _ => {}
            }
        }
        if database == "main" && table == "capture_file_holds" {
            hold_writes.fetch_add(1, Ordering::Relaxed);
        }
        if database == "main"
            && matches!(
                table,
                "engine_search_files_fts_content"
                    | "engine_search_chat_messages_fts_content"
                    | "engine_search_index_state"
                    | "snapshots"
                    | "chat_messages"
                    | "chat_threads"
            )
        {
            writes.store(true, Ordering::Relaxed);
        }
    }))?;
    conn.create_scalar_function(
        "dohc_placement_hold_generation",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        move |_| Ok(hold_generation.load(Ordering::Relaxed)),
    )?;
    conn.create_scalar_function(
        "dohc_search_generation",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        move |_| {
            if dirty.swap(false, Ordering::Relaxed) {
                generation.fetch_add(1, Ordering::Relaxed);
            }
            Ok(generation.load(Ordering::Relaxed))
        },
    )
}

/// Read the connection's search revision without counting unrelated writes.
/// FTS content rows carry candidate identities; snapshots and chat rows carry
/// live filtering, previews, and line coordinates.
pub fn search_generation(conn: &Connection) -> rusqlite::Result<u64> {
    let generation: i64 =
        conn.query_row("SELECT dohc_search_generation()", [], |row| row.get(0))?;
    u64::try_from(generation).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, generation))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn row_writes_coalesce_until_the_search_revision_is_read() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE snapshots(value INTEGER); CREATE TABLE link_pending(value INTEGER); CREATE TABLE capture_file_holds(value INTEGER);",
        )
        .unwrap();
        install(&conn).unwrap();
        assert_eq!(search_generation(&conn).unwrap(), 0);
        assert_eq!(crate::capture_file_holds::generation_in(&conn).unwrap(), 0);
        conn.execute_batch(
            "INSERT INTO snapshots VALUES (1),(2),(3); INSERT INTO link_pending VALUES(1);",
        )
        .unwrap();
        assert_eq!(search_generation(&conn).unwrap(), 1);
        assert_eq!(search_generation(&conn).unwrap(), 1);
        conn.execute("UPDATE link_pending SET value=2", []).unwrap();
        assert_eq!(search_generation(&conn).unwrap(), 1);
        conn.execute("UPDATE snapshots SET value=4", []).unwrap();
        assert_eq!(search_generation(&conn).unwrap(), 2);
        assert_eq!(crate::capture_file_holds::generation_in(&conn).unwrap(), 0);
        conn.execute_batch("INSERT INTO capture_file_holds VALUES(1);")
            .unwrap();
        assert_eq!(crate::capture_file_holds::generation_in(&conn).unwrap(), 1);
        assert_eq!(search_generation(&conn).unwrap(), 2);
        conn.execute_batch("BEGIN; DELETE FROM capture_file_holds WHERE value=1; ROLLBACK;")
            .unwrap();
        assert_eq!(crate::capture_file_holds::generation_in(&conn).unwrap(), 2);
    }
}
