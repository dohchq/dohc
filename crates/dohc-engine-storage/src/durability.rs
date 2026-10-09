use crate::StorageError;
use rusqlite::Connection;

/// Run a commit at FULL, then restore the connection's setting, including on error.
/// The work must change a row: an empty commit does not sync the WAL.
pub(crate) fn with_full_synchronous<T, E>(
    conn: &Connection,
    work: impl FnOnce(&Connection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<StorageError>,
{
    let session: i64 = conn
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    conn.pragma_update(None, "synchronous", 2)
        .map_err(StorageError::persist)?;
    let result = work(conn);
    let restored = conn
        .pragma_update(None, "synchronous", session)
        .map_err(StorageError::persist);
    let value = result?;
    restored?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_synchronous_restores_after_success_and_error() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "synchronous", 1).unwrap();
        let setting = |conn: &Connection| -> Result<i64, StorageError> {
            conn.pragma_query_value(None, "synchronous", |row| row.get(0))
                .map_err(StorageError::corrupt)
        };
        assert_eq!(with_full_synchronous(&conn, setting).unwrap(), 2);
        assert_eq!(setting(&conn).unwrap(), 1);
        let failed: Result<(), StorageError> = with_full_synchronous(&conn, |conn| {
            assert_eq!(setting(conn)?, 2);
            Err(StorageError::persist(rusqlite::Error::InvalidQuery))
        });
        assert!(failed.is_err());
        assert_eq!(setting(&conn).unwrap(), 1);
    }
}
