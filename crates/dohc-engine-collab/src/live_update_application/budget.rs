use super::*;
use std::io::Write;

pub(super) struct Budget {
    pub(super) remaining: usize,
}
impl Budget {
    pub(super) fn sql_json_array(
        &mut self,
        conn: &Connection,
        columns: &[&str],
        source: &str,
        parameters: &[&dyn rusqlite::ToSql],
    ) -> Result<String, ApplicationError> {
        use rusqlite::types::ValueRef;
        use serde::ser::{Error, SerializeSeq};

        let lengths = columns
            .iter()
            .map(|column| format!("coalesce(length(CAST({column} AS BLOB)),0)"))
            .collect::<Vec<_>>()
            .join("+");
        let length: i64 = conn
            .query_row(&format!("SELECT {lengths} {source}"), parameters, |row| {
                row.get(0)
            })
            .map_err(read_sql)?;
        if usize::try_from(length).map_err(|_| ApplicationError::Corrupt)? > self.remaining {
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        }
        // Bound the raw columns before reading them, then charge JSON escaping
        // through the same incremental writer as other configured metadata.
        struct SqlArray<'a>(&'a rusqlite::Row<'a>);
        impl Serialize for SqlArray<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let count = self.0.as_ref().column_count();
                let mut array = serializer.serialize_seq(Some(count))?;
                for index in 0..count {
                    match self.0.get_ref(index).map_err(S::Error::custom)? {
                        ValueRef::Null => array.serialize_element(&Option::<u8>::None)?,
                        ValueRef::Integer(value) => array.serialize_element(&value)?,
                        ValueRef::Text(value) => array.serialize_element(
                            std::str::from_utf8(value).map_err(S::Error::custom)?,
                        )?,
                        _ => return Err(S::Error::custom("invalid evidence column type")),
                    }
                }
                array.end()
            }
        }
        let mut statement = conn
            .prepare(&format!("SELECT {} {source}", columns.join(",")))
            .map_err(read_sql)?;
        let mut rows = statement.query(parameters).map_err(read_sql)?;
        let row = rows
            .next()
            .map_err(read_sql)?
            .ok_or(ApplicationError::Corrupt)?;
        String::from_utf8(self.json(&SqlArray(row))?).map_err(|_| ApplicationError::Corrupt)
    }

    pub(super) fn charge(&mut self, bytes: usize) -> Result<(), ApplicationError> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
        Ok(())
    }
    fn blob_length(&mut self, conn: &Connection, digest: &str) -> Result<usize, ApplicationError> {
        let (length, actual): (i64, i64) = conn
            .query_row(
                "SELECT byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
                [digest],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(read_sql)?;
        if length != actual
            || length < 0
            || length as u64 > crate::limits::MAX_YDOC_UPDATE_BYTES as u64
        {
            return Err(ApplicationError::Corrupt);
        }
        let length = usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?;
        self.charge(length)?;
        Ok(length)
    }
    pub(super) fn blob(
        &mut self,
        conn: &Connection,
        digest: &str,
    ) -> Result<Vec<u8>, ApplicationError> {
        self.blob_length(conn, digest)?;
        get_binary_blob(conn, digest)?.ok_or(ApplicationError::Corrupt)
    }
    pub(super) fn json(&mut self, value: &impl Serialize) -> Result<Vec<u8>, ApplicationError> {
        struct Bounded<'a> {
            budget: &'a mut Budget,
            bytes: Vec<u8>,
            exceeded: bool,
        }
        impl Write for Bounded<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if let Err(error) = self.budget.charge(bytes.len()) {
                    self.exceeded = true;
                    return Err(std::io::Error::other(error));
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Bounded {
            budget: self,
            bytes: Vec::new(),
            exceeded: false,
        };
        if serde_json::to_writer(&mut writer, value).is_err() {
            return Err(if writer.exceeded {
                ApplicationError::ConfiguredByteBudgetExceeded
            } else {
                ApplicationError::Corrupt
            });
        }
        Ok(writer.bytes)
    }
}
