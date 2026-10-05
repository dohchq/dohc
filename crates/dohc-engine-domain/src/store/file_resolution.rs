use super::{VersionedTextStore, validate_identifier};
use crate::DomainError;
use rusqlite::{OptionalExtension, params};

#[derive(Debug, Clone)]
pub enum FileResolveTarget {
    Path(String),
    ObjectId(String),
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FileResolution {
    Found {
        #[serde(rename = "objectId")]
        object_id: String,
        path: String,
    },
    Absent,
    Invalid,
}

const FILE_PATH_SQL: &str =
    "SELECT path FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3";

impl VersionedTextStore<'_> {
    /// Resolve file identities without reading bodies. All targets share one read transaction.
    pub fn resolve_files(
        &self,
        workspace_id: &str,
        version_id: Option<&str>,
        targets: &[FileResolveTarget],
    ) -> Result<(String, Vec<FileResolution>), DomainError> {
        self.store.read_with(|conn| {
            let _transaction = conn
                .unchecked_transaction()
                .map_err(DomainError::sql_corrupt)?;
            let version = match version_id {
                Some(id) => self.require_version(workspace_id, id)?,
                None => self.get_active_version(workspace_id)?,
            };
            let mut results = Vec::with_capacity(targets.len());
            for target in targets {
                let object_id = match target {
                    FileResolveTarget::Path(path) => {
                        match self.object_id_for_path(workspace_id, &version.version_id, path) {
                            Ok(Some(id)) => id,
                            Ok(None) => {
                                results.push(FileResolution::Absent);
                                continue;
                            }
                            Err(DomainError::InvalidPath { .. }) => {
                                results.push(FileResolution::Invalid);
                                continue;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    FileResolveTarget::ObjectId(id) => {
                        if validate_identifier(id, "object_id").is_err() {
                            results.push(FileResolution::Invalid);
                            continue;
                        }
                        id.clone()
                    }
                    FileResolveTarget::Invalid => {
                        results.push(FileResolution::Invalid);
                        continue;
                    }
                };
                let path: Option<String> = conn
                    .query_row(
                        FILE_PATH_SQL,
                        params![workspace_id, version.version_id, object_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                match path {
                    Some(path) => {
                        // Both directions must agree; a dangling alias or snapshot is corruption.
                        let alias = self
                            .object_id_for_path(workspace_id, &version.version_id, &path)
                            .map_err(|error| match error {
                                DomainError::InvalidPath { .. } => DomainError::StateCorrupt {
                                    reason: "file snapshot has an invalid path",
                                },
                                other => other,
                            })?;
                        if alias != Some(object_id.clone()) {
                            return Err(DomainError::StateCorrupt {
                                reason: "file snapshot and path alias disagree",
                            });
                        }
                        results.push(FileResolution::Found { object_id, path });
                    }
                    None if matches!(target, FileResolveTarget::Path(_)) => {
                        return Err(DomainError::StateCorrupt {
                            reason: "file alias has no snapshot",
                        });
                    }
                    None => results.push(FileResolution::Absent),
                }
            }
            Ok((version.version_id, results))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::EngineStore;
    #[test]
    fn file_resolution_uses_indexed_queries() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store = EngineStore::open(&root.path().join("engine.db"), 1).unwrap();
        store
            .read_with(|conn| -> rusqlite::Result<()> {
                for query in [FILE_PATH_SQL, super::super::ALIAS_OBJECT_ID_SQL] {
                    let plan: String = conn.query_row(
                        &format!("EXPLAIN QUERY PLAN {query}"),
                        params!["ws", "main", "file"],
                        |row| row.get(3),
                    )?;
                    assert!(plan.contains("SEARCH") && plan.contains("INDEX"), "{plan}");
                    assert!(!plan.contains("SCAN"), "{plan}");
                }
                Ok(())
            })
            .unwrap();
    }
}
