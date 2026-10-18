//! Document body access. Callers own authorization, caps and error mapping;
//! this module owns the physical full-body representation.
use rusqlite::{Connection, Row, RowIndex};

use std::collections::HashMap;

/// Keep metadata and body queries in one snapshot, including in autocommit.
pub struct ReadSnapshot<'a>(Option<&'a Connection>);

impl<'a> ReadSnapshot<'a> {
    pub fn new(conn: &'a Connection) -> rusqlite::Result<Self> {
        if conn.is_autocommit() {
            conn.execute_batch("SAVEPOINT text_read")?;
            Ok(Self(Some(conn)))
        } else {
            Ok(Self(None))
        }
    }

    pub fn finish<T, E>(
        mut self,
        result: Result<T, E>,
        map_error: impl Fn(rusqlite::Error) -> E,
    ) -> Result<T, E> {
        let value = result?;
        if let Some(conn) = self.0 {
            conn.execute_batch("RELEASE text_read").map_err(map_error)?;
            self.0 = None;
        }
        Ok(value)
    }
}

impl Drop for ReadSnapshot<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.0 {
            let _ = conn.execute_batch("ROLLBACK TO text_read; RELEASE text_read");
        }
    }
}

pub struct Body {
    pub recorded: i64,
    pub actual: i64,
    pub text: Option<String>,
    remaining: usize,
}

impl Body {
    /// Move the last requested copy into its result; clone only shared bodies.
    pub fn take_text(&mut self) -> Option<String> {
        self.remaining -= 1;
        if self.remaining == 0 {
            self.text.take()
        } else {
            self.text.clone()
        }
    }
}

/// Fetch each distinct key once. Callers omit NULL joined keys and retain NULL.
/// A requested digest missing from the result is corruption.
pub fn read_batch<'a>(
    conn: &Connection,
    digests: impl IntoIterator<Item = &'a str>,
    cap: Option<i64>,
) -> rusqlite::Result<HashMap<String, Body>> {
    let mut keys = HashMap::new();
    for key in digests {
        *keys.entry(key).or_insert(0usize) += 1;
    }
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let json =
        serde_json::to_string(&keys.keys().collect::<Vec<_>>()).expect("text keys serialize");
    let mut statement = conn.prepare_cached(if cap.is_some() {
        "SELECT sha256,byte_length,length(CAST(text AS BLOB)), \
         CASE WHEN byte_length<=?2 AND length(CAST(text AS BLOB))<=?2 THEN text END \
         FROM blobs WHERE sha256 IN (SELECT value FROM json_each(?1))"
    } else {
        "SELECT sha256,byte_length,NULL,text FROM blobs \
         WHERE sha256 IN (SELECT value FROM json_each(?1))"
    })?;
    let map = |row: &Row<'_>| {
        let text = if cap.is_some() {
            row.get(3)?
        } else {
            Some(row.get::<_, String>(3)?)
        };
        let actual = if cap.is_some() {
            row.get(2)?
        } else {
            text.as_ref().expect("uncapped body").len() as i64
        };
        Ok((
            row.get(0)?,
            Body {
                recorded: row.get(1)?,
                actual,
                text,
                remaining: 0,
            },
        ))
    };
    let mut bodies: HashMap<String, Body> = if let Some(cap) = cap {
        statement
            .query_map(rusqlite::params![json, cap], map)?
            .collect::<Result<_, _>>()?
    } else {
        statement
            .query_map([json], map)?
            .collect::<Result<_, _>>()?
    };
    if bodies.len() != keys.len() {
        return Err(missing_body(rusqlite::Error::QueryReturnedNoRows));
    }
    for (key, body) in &mut bodies {
        body.remaining = keys[key.as_str()];
    }
    Ok(bodies)
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
