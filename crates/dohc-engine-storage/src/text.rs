//! Document body access. Callers own authorization, caps and error mapping;
//! this module owns the physical full-body representation.
use rusqlite::{Connection, Row, RowIndex, ToSql, types::FromSql};

/// Read without adding validation or changing the caller's error precedence.
pub fn read<T: FromSql>(conn: &Connection, sha256: impl ToSql) -> rusqlite::Result<T> {
    conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [sha256], |row| {
        row.get(0)
    })
}

pub fn read_sized(conn: &Connection, sha256: &str, byte_length: i64) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT text FROM blobs WHERE sha256=?1 AND byte_length=?2",
        rusqlite::params![sha256, byte_length],
        |row| row.get(0),
    )
}

/// The low-level collab API retains its existing binary materialization backend.
pub fn put_projection(
    conn: &Connection,
    bytes: &[u8],
    sha256: &str,
) -> Result<String, crate::StorageError> {
    crate::put_binary_blob_with_sha(conn, bytes, sha256)
}

pub fn put_materialization(conn: &Connection, bytes: &[u8]) -> Result<String, crate::StorageError> {
    crate::put_binary_blob(conn, bytes)
}

/// Materialization can retain binary files and known text projections.
pub fn read_materialization_bytes(
    conn: &Connection,
    sha256: &str,
) -> Result<Option<Vec<u8>>, crate::StorageError> {
    crate::get_binary_blob(conn, sha256)
}

/// Retained artifact evidence is untyped bytes, not a canonical text blob.
pub(crate) fn retain_displacement(
    conn: &Connection,
    old: &crate::RetainedDisplacement,
    new: &crate::RetainedDisplacement,
    bytes: &[u8],
    now_ms: i64,
) -> rusqlite::Result<usize> {
    conn.execute("INSERT OR IGNORE INTO materialization_displacement_reads(workspace_id,displacement_id,job_id,target_path,sha256,bytes,observed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",rusqlite::params![old.workspace_id,format!("retained:{}",old.displacement_id),old.job_id,old.target_path,new.digest,bytes,now_ms])
}

/// Derived search bodies stay in the FTS query, so admission can precede hydration.
pub const SEARCH_BODY_COLUMNS: &str = "length(CAST(text AS BLOB)), text";

pub fn search_value<T: FromSql>(row: &Row<'_>, column: usize) -> rusqlite::Result<T> {
    row.get(column)
}

/// Current search text is a derived index, separate from canonical body storage.
pub fn index_file(
    conn: &Connection,
    workspace: &str,
    version: &str,
    object: &str,
    path: &str,
    body: &str,
) -> rusqlite::Result<usize> {
    conn.prepare_cached("INSERT INTO engine_search_files_fts (workspace_id,version_id,object_id,path,text) VALUES (?1,?2,?3,?4,?5)")?.execute(rusqlite::params![workspace,version,object,path,body])
}

pub fn with_length(conn: &Connection, sha256: impl ToSql) -> rusqlite::Result<(i64, String)> {
    conn.query_row(
        "SELECT byte_length,text FROM blobs WHERE sha256=?1",
        [sha256],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

pub fn lengths(conn: &Connection, sha256: impl ToSql) -> rusqlite::Result<(i64, i64)> {
    conn.query_row(
        "SELECT byte_length,length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1",
        [sha256],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

/// Length projections may also carry a binary length or a NULL outer join.
pub fn length_from_row<T: FromSql, I: RowIndex + Copy>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<T> {
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Text(_) => conn.query_row(
            "SELECT length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1",
            [row.get_ref(column)?.as_str()?],
            |r| r.get(0),
        ),
        _ => row.get(column),
    }
}

pub fn capped_from_row<I: RowIndex + Copy>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
    cap: i64,
) -> rusqlite::Result<Option<String>> {
    match row.get_ref(column)?.as_str_or_null()? {
        Some(sha) => capped(conn, sha, cap).map(|(_, _, text)| text),
        None => Ok(None),
    }
}

pub fn equals(conn: &Connection, sha256: &str, text: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM blobs WHERE sha256=?1 AND text=?2)",
        [sha256, text],
        |row| row.get(0),
    )
}

pub fn capped(
    conn: &Connection,
    sha256: impl ToSql,
    cap: i64,
) -> rusqlite::Result<(i64, i64, Option<String>)> {
    conn.query_row("SELECT byte_length,length(CAST(text AS BLOB)),CASE WHEN byte_length<=?2 AND length(CAST(text AS BLOB))<=?2 THEN text END FROM blobs WHERE sha256=?1", rusqlite::params![sha256,cap], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
}

/// SQLite character offsets and byte offsets deliberately have separate paths.
pub fn prefix_from_row<T: FromSql, I: RowIndex + Copy>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<T> {
    match row.get_ref(column)?.as_str_or_null()? {
        Some(sha) => conn.query_row(
            "SELECT substr(text,1,65536) FROM blobs WHERE sha256=?1",
            [sha],
            |r| r.get(0),
        ),
        None => row.get(column),
    }
}

pub fn byte_range(
    conn: &Connection,
    sha256: &str,
    start: i64,
    length: i64,
) -> rusqlite::Result<Vec<u8>> {
    conn.query_row(
        "SELECT substr(CAST(text AS BLOB),?2,?3) FROM blobs WHERE sha256=?1",
        rusqlite::params![sha256, start, length],
        |row| row.get(0),
    )
}

/// Hydrate a body selected by a metadata query. A NULL joined key remains NULL.
pub fn from_row<T: FromSql, I: RowIndex + Copy>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<T> {
    match row.get_ref(column)?.as_str_or_null()? {
        Some(sha256) => read(conn, sha256),
        None => row.get(column),
    }
}

/// Preserve the distinction between an ordinary insert and deduplication.
pub fn insert(
    conn: &Connection,
    sha256: &str,
    byte_length: i64,
    text: &str,
    ignore_existing: bool,
) -> rusqlite::Result<usize> {
    conn.execute(
        if ignore_existing {
            "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)"
        } else {
            "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)"
        },
        rusqlite::params![sha256, byte_length, text],
    )
}
