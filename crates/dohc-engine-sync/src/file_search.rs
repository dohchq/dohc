use std::path::Path;

use dohc_engine_files::search_policy::{
    SearchPolicySnapshot, path_is_search_indexed, read_engine_search_policy,
};
use dohc_engine_storage::EngineStore;
use rusqlite::{Transaction, params};

use crate::SyncError;

pub(crate) fn search_policy_for_store(store: &EngineStore) -> Option<SearchPolicySnapshot> {
    workspace_root_from_database(store.database_path()).map(read_engine_search_policy)
}

pub(crate) fn delete_file_search_index(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "DELETE FROM engine_search_files_fts \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![workspace_id, version_id, object_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn upsert_file_search_index(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: Option<&str>,
    policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    let Some(policy) = policy.filter(|policy| !policy.is_degraded()) else {
        tx.execute(
            "UPDATE engine_search_index_state SET file_policy_degraded=1 \
             WHERE workspace_id=?1 AND version_id=?2",
            params![workspace_id, version_id],
        )
        .map_err(SyncError::persist)?;
        return Ok(());
    };
    delete_file_search_index(tx, workspace_id, version_id, object_id)?;
    if let Some(text) = text
        && path_is_search_indexed(policy, path)
    {
        tx.execute(
            "INSERT INTO engine_search_files_fts (workspace_id,version_id,object_id,path,text) \
             VALUES (?1,?2,?3,?4,?5)",
            params![workspace_id, version_id, object_id, path, text],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

fn workspace_root_from_database(database_path: &Path) -> Option<&Path> {
    let engine_dir = database_path.parent()?;
    let dohc_dir = engine_dir.parent()?;
    if database_path.file_name()? != "engine.db"
        || engine_dir.file_name()? != "engine"
        || dohc_dir.file_name()? != ".dohc"
    {
        return None;
    }
    dohc_dir.parent()
}
