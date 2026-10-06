//! Connection-local revision for search content and result coordinates.

use rusqlite::{Connection, functions::FunctionFlags};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

pub(crate) fn install(conn: &Connection) -> rusqlite::Result<()> {
    let generation = Arc::new(AtomicI64::new(0));
    let writes = Arc::clone(&generation);
    conn.update_hook(Some(move |_, database: &str, table: &str, _| {
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
            writes.fetch_add(1, Ordering::Relaxed);
        }
    }))?;
    conn.create_scalar_function(
        "dohc_search_generation",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        move |_| Ok(generation.load(Ordering::Relaxed)),
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
