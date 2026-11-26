use dohc_engine_files::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_storage::text;
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) const DESCRIPTOR: &str = "dataset.json";
pub(crate) const DESCRIPTOR_MAX_BYTES: i64 = 256 * 1024;

pub(crate) fn safe_path(path: &str) -> bool {
    let (kind, normalized) = classify_engine_file_path_normalized(path);
    kind == PathClassification::Tracked
        && normalized.as_deref() == Some(path)
        && path.split('/').all(|part| {
            let key = dohc_engine_files::floor::collision_key(part);
            !part.contains(':')
                && key != ".dohc-access"
                && key != ".env"
                && !key.starts_with(".env.")
        })
}

pub(crate) struct RuleSources {
    operations: String,
}

impl RuleSources {
    fn parse(text: &str, folder: &str) -> Option<Self> {
        let descriptor: serde_json::Value = serde_json::from_str(text).ok()?;
        let format = descriptor.get("formatVersion")?.as_u64()?;
        let source = |key: &str, default: &str| match format {
            1 => Some(descriptor.get(key)?.as_str()?.to_owned()),
            2 => {
                let relative = match descriptor.get(key) {
                    Some(value) => value.as_str()?,
                    None => default,
                };
                Some(format!("{folder}/{relative}"))
            }
            _ => None,
        };
        let schema = source("schemaPath", "schema.sql")?;
        let operations = source("operationsPath", "operations.js")?;
        let prefix = format!("{folder}/");
        (schema.ends_with(".sql")
            && (operations.ends_with(".ts") || operations.ends_with(".js"))
            && [&schema, &operations]
                .into_iter()
                .all(|path| path.starts_with(&prefix) && safe_path(path)))
        .then_some(Self { operations })
    }

    pub(crate) fn read(
        conn: &Connection,
        digest: &str,
        folder: &str,
    ) -> rusqlite::Result<Option<Self>> {
        let raw = text::capped(conn, digest, DESCRIPTOR_MAX_BYTES)
            .optional()?
            .and_then(|(_, _, text)| text);
        Ok(raw.and_then(|text| Self::parse(&text, folder)))
    }

    pub(crate) fn allows(&self, folder: &str, path: &str) -> bool {
        path.strip_prefix(folder)
            .and_then(|relative| relative.strip_prefix('/'))
            .is_some_and(|relative| {
                safe_path(path)
                    && (relative == DESCRIPTOR || path == self.operations || path.ends_with(".sql"))
            })
    }
}

pub(crate) fn descriptor_at(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    let mut query = conn.prepare_cached(
        "SELECT COALESCE(blob_sha256,'') FROM snapshots
         WHERE workspace_id=?1 AND version_id='main' AND path=?2",
    )?;
    for (end, _) in path.rmatch_indices('/').filter(|(end, _)| *end > 0) {
        let folder = &path[..end];
        let digest = query
            .query_row(
                params![workspace_id, format!("{folder}/{DESCRIPTOR}")],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(digest) = digest {
            return Ok(Some((folder.to_owned(), digest)));
        }
    }
    Ok(None)
}
