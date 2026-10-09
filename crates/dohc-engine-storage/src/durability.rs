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
    let fullfsync: i64 = conn
        .pragma_query_value(None, "fullfsync", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    let result = (|| {
        conn.pragma_update(None, "fullfsync", 1)
            .map_err(StorageError::persist)?;
        conn.pragma_update(None, "synchronous", 2)
            .map_err(StorageError::persist)?;
        work(conn)
    })();
    let restored = conn
        .pragma_update(None, "synchronous", session)
        .map_err(StorageError::persist);
    let restored_fullfsync = conn
        .pragma_update(None, "fullfsync", fullfsync)
        .map_err(StorageError::persist);
    let value = result?;
    restored?;
    restored_fullfsync?;
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
        let fullfsync = |conn: &Connection| -> Result<i64, StorageError> {
            conn.pragma_query_value(None, "fullfsync", |row| row.get(0))
                .map_err(StorageError::corrupt)
        };
        for previous in [0, 1] {
            conn.pragma_update(None, "fullfsync", previous).unwrap();
            with_full_synchronous(&conn, |conn| {
                assert_eq!(setting(conn)?, 2);
                assert_eq!(fullfsync(conn)?, 1);
                Ok::<_, StorageError>(())
            })
            .unwrap();
            assert_eq!(setting(&conn).unwrap(), 1);
            assert_eq!(fullfsync(&conn).unwrap(), previous);
        }
        conn.pragma_update(None, "fullfsync", 0).unwrap();
        assert_eq!(setting(&conn).unwrap(), 1);
        let failed: Result<(), StorageError> = with_full_synchronous(&conn, |conn| {
            assert_eq!(setting(conn)?, 2);
            assert_eq!(fullfsync(conn)?, 1);
            Err(StorageError::persist(rusqlite::Error::InvalidQuery))
        });
        assert!(failed.is_err());
        assert_eq!(fullfsync(&conn).unwrap(), 0);
        assert_eq!(setting(&conn).unwrap(), 1);
    }
}
