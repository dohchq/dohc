//! Document body access. Callers own authorization, caps and error mapping;
//! this module owns the physical full-body representation.
use rusqlite::{Connection, Row, RowIndex};

/// Body projection for a trusted SQL table alias. Keep joined list hydration
/// in its outer statement; the chunk backend changes this expression.
pub fn body_column(alias: &str) -> String {
    format!("{alias}.text")
}

/// Read without adding validation or changing the caller's error precedence.
pub fn read(conn: &Connection, sha256: &str) -> rusqlite::Result<String> {
    conn.prepare_cached("SELECT text FROM blobs WHERE sha256=?1")?
        .query_row([sha256], |row| row.get(0))
}

pub fn read_sized(conn: &Connection, sha256: &str, byte_length: i64) -> rusqlite::Result<String> {
    conn.prepare_cached("SELECT text FROM blobs WHERE sha256=?1 AND byte_length=?2")?
        .query_row(rusqlite::params![sha256, byte_length], |row| row.get(0))
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

pub fn with_length(conn: &Connection, sha256: &str) -> rusqlite::Result<(i64, String)> {
    conn.prepare_cached("SELECT byte_length,text FROM blobs WHERE sha256=?1")?
        .query_row([sha256], |row| Ok((row.get(0)?, row.get(1)?)))
}

pub fn lengths(conn: &Connection, sha256: &str) -> rusqlite::Result<(i64, i64)> {
    conn.prepare_cached("SELECT byte_length,length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1")?
        .query_row([sha256], |row| Ok((row.get(0)?, row.get(1)?)))
}

/// Select the joined text digest and binary byte length separately.
pub fn length_from_row<I: RowIndex, J: RowIndex>(
    conn: &Connection,
    row: &Row<'_>,
    digest: I,
    binary_length: J,
) -> rusqlite::Result<i64> {
    match row.get_ref(digest)?.as_str_or_null()? {
        Some(sha) => conn
            .prepare_cached("SELECT length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1")?
            .query_row([sha], |r| r.get(0))
            .map_err(missing_body),
        None => row.get(binary_length),
    }
}

pub fn equals(conn: &Connection, sha256: &str, text: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM blobs WHERE sha256=?1 AND text=?2)")?
        .query_row([sha256, text], |row| row.get(0))
}

pub fn capped(
    conn: &Connection,
    sha256: &str,
    cap: i64,
) -> rusqlite::Result<(i64, i64, Option<String>)> {
    conn.prepare_cached(
        "SELECT byte_length, length(CAST(text AS BLOB)), \
         CASE WHEN byte_length<=?2 AND length(CAST(text AS BLOB))<=?2 THEN text END \
         FROM blobs WHERE sha256=?1",
    )?
    .query_row(rusqlite::params![sha256, cap], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
}

/// SQLite character offsets and byte offsets deliberately have separate paths.
pub fn prefix_from_row<I: RowIndex>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<String> {
    let sha: &str = row.get_ref(column)?.as_str()?;
    conn.prepare_cached("SELECT substr(text,1,65536) FROM blobs WHERE sha256=?1")?
        .query_row([sha], |r| r.get(0))
        .map_err(missing_body)
}

pub fn byte_range(
    conn: &Connection,
    sha256: &str,
    start: i64,
    length: i64,
) -> rusqlite::Result<Vec<u8>> {
    conn.prepare_cached("SELECT substr(CAST(text AS BLOB),?2,?3) FROM blobs WHERE sha256=?1")?
        .query_row(rusqlite::params![sha256, start, length], |row| row.get(0))
}

fn missing_body(error: rusqlite::Error) -> rusqlite::Error {
    match error {
        rusqlite::Error::QueryReturnedNoRows => rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some("selected text body is missing".into()),
        ),
        other => other,
    }
}

/// Hydrate a body selected by metadata. Missing bodies are corruption.
pub fn from_row<I: RowIndex>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<String> {
    read(conn, row.get_ref(column)?.as_str()?).map_err(missing_body)
}

/// A NULL outer-join key remains NULL; a missing selected body is corruption.
pub fn optional_from_row<I: RowIndex>(
    conn: &Connection,
    row: &Row<'_>,
    column: I,
) -> rusqlite::Result<Option<String>> {
    match row.get_ref(column)?.as_str_or_null()? {
        Some(sha) => read(conn, sha).map(Some).map_err(missing_body),
        None => Ok(None),
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
