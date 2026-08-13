use std::collections::{BTreeMap, HashSet};

use dohc_engine_storage::{hex_sha256, StorageError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::durable::{load_for_replay_gate, query_marker};
use crate::{scene_asset_directory, scene_asset_ref_is_owned, CollabError, ContentKind, DocKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneAssetDeleteAuthority {
    pub asset_delete_moment_id: String,
    pub path: String,
    pub sha256: String,
}

pub fn scene_asset_delete_moment_id(
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
    path: &str,
) -> String {
    format!(
        "moment-scene-asset-delete-{}",
        hex_sha256(
            format!("{workspace_id}\0{version_id}\0{drawing_delete_moment_id}\0{path}").as_bytes()
        )
    )
}

pub fn freeze_scene_asset_delete_authority_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    drawing_delete_moment_id: &str,
) -> Result<Vec<SceneAssetDeleteAuthority>, CollabError> {
    let parent = tx
        .query_row(
            "SELECT operation,before_content_kind FROM moments \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND moment_id=?4",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                drawing_delete_moment_id
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(corrupt)?;
    if parent
        .as_ref()
        .is_none_or(|(operation, kind)| operation != "delete" || kind != "text")
    {
        return Err(CollabError::Corrupt {
            reason: "scene asset authority parent is not the exact drawing delete".to_owned(),
        });
    }

    let scopes = scene_asset_owner_scopes(tx, key)?;
    let is_scene = scopes.iter().try_fold(false, |found, (version_id, _)| {
        let scoped_key = DocKey::new(&key.workspace_id, version_id, &key.object_id)?;
        Ok::<_, CollabError>(
            found
                || query_marker(tx, &scoped_key)?
                    .is_some_and(|marker| marker.content_kind == ContentKind::Scene),
        )
    })?;
    if !is_scene {
        return Ok(Vec::new());
    }

    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO scene_asset_delete_authorities \
             (workspace_id,version_id,drawing_object_id,drawing_delete_moment_id) \
             VALUES (?1,?2,?3,?4)",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                drawing_delete_moment_id
            ],
        )
        .map_err(persist)?;
    if inserted == 0 {
        return read_scene_asset_delete_authority(tx, key, drawing_delete_moment_id);
    }

    let canonical_assets = canonical_scene_assets(tx, key, &scopes)?;
    let mut candidates = BTreeMap::new();
    for (_, owner_directory) in &scopes {
        let pattern = format!("{owner_directory}/*");
        let mut statement = tx
            .prepare(
                "SELECT a.path,s.binary_sha256,s.metadata_origin FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id=a.workspace_id \
                   AND s.version_id=a.version_id AND s.object_id=a.object_id \
                 LEFT JOIN moments producer ON producer.workspace_id=s.workspace_id \
                   AND producer.moment_id=s.latest_moment_id \
                 WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path GLOB ?3 \
                   AND s.content_kind='binary' \
                   AND (s.metadata_origin='ydoc' OR (s.metadata_origin='sync' \
                     AND producer.version_id=s.version_id \
                     AND producer.object_id=s.object_id \
                     AND producer.operation='write' \
                     AND producer.after_content_kind='binary' \
                     AND producer.after_binary_sha256=s.binary_sha256 \
                     AND producer.path=a.path AND producer.payload_after_path=a.path \
                     AND producer.metadata_origin='local-file')) \
                 ORDER BY a.path",
            )
            .map_err(corrupt)?;
        let rows = statement
            .query_map(params![key.workspace_id, key.version_id, pattern], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(corrupt)?;
        for row in rows {
            let (path, sha256, origin) = row.map_err(corrupt)?;
            if origin == "ydoc" || canonical_assets.get(&path) == Some(&sha256) {
                candidates.insert(path, sha256);
            }
        }
    }

    for (path, sha256) in candidates {
        if !scopes
            .iter()
            .any(|(_, directory)| scene_asset_ref_is_owned(directory, &path, &sha256))
        {
            continue;
        }
        let asset_delete_moment_id = scene_asset_delete_moment_id(
            &key.workspace_id,
            &key.version_id,
            drawing_delete_moment_id,
            &path,
        );
        tx.execute(
            "INSERT INTO scene_asset_delete_authority_items \
             (workspace_id,version_id,drawing_delete_moment_id,asset_delete_moment_id,asset_path,asset_sha256) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                key.workspace_id,
                key.version_id,
                drawing_delete_moment_id,
                asset_delete_moment_id,
                path,
                sha256
            ],
        )
        .map_err(persist)?;
    }
    read_scene_asset_delete_authority(tx, key, drawing_delete_moment_id)
}

pub fn read_scene_asset_delete_authority(
    conn: &Connection,
    key: &DocKey,
    drawing_delete_moment_id: &str,
) -> Result<Vec<SceneAssetDeleteAuthority>, CollabError> {
    let parent: Option<String> = conn
        .query_row(
            "SELECT drawing_object_id FROM scene_asset_delete_authorities \
             WHERE workspace_id=?1 AND version_id=?2 AND drawing_delete_moment_id=?3",
            params![key.workspace_id, key.version_id, drawing_delete_moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(corrupt)?;
    let Some(parent_object_id) = parent else {
        return Ok(Vec::new());
    };
    if parent_object_id != key.object_id {
        return Err(CollabError::Corrupt {
            reason: "scene asset authority belongs to a different drawing".to_owned(),
        });
    }
    let mut statement = conn
        .prepare(
            "SELECT asset_delete_moment_id,asset_path,asset_sha256 \
             FROM scene_asset_delete_authority_items \
             WHERE workspace_id=?1 AND version_id=?2 AND drawing_delete_moment_id=?3 \
             ORDER BY asset_path",
        )
        .map_err(corrupt)?;
    let rows = statement
        .query_map(
            params![key.workspace_id, key.version_id, drawing_delete_moment_id],
            |row| {
                Ok(SceneAssetDeleteAuthority {
                    asset_delete_moment_id: row.get(0)?,
                    path: row.get(1)?,
                    sha256: row.get(2)?,
                })
            },
        )
        .map_err(corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(corrupt)?;
    Ok(rows)
}

fn canonical_scene_assets(
    conn: &Connection,
    key: &DocKey,
    scopes: &[(String, String)],
) -> Result<BTreeMap<String, String>, CollabError> {
    let mut assets = BTreeMap::new();
    for (version_id, directory) in scopes {
        let scoped_key = DocKey::new(&key.workspace_id, version_id, &key.object_id)?;
        let Some(marker) = query_marker(conn, &scoped_key)? else {
            continue;
        };
        if marker.content_kind != ContentKind::Scene
            || (marker.head_update_seq == 0
                && marker.head_snapshot_seq == 0
                && !marker.base_claimed)
        {
            continue;
        }
        let doc = load_for_replay_gate(conn, &scoped_key)?;
        if doc.has_pending_dependencies() {
            return Err(CollabError::MissingDependencies);
        }
        let folded = doc.fold_scene();
        let live_file_ids = folded
            .elements
            .iter()
            .filter(|element| {
                element.get("type").and_then(serde_json::Value::as_str) == Some("image")
                    && element
                        .get("isDeleted")
                        .and_then(serde_json::Value::as_bool)
                        == Some(false)
            })
            .filter_map(|element| element.get("fileId").and_then(serde_json::Value::as_str))
            .collect::<HashSet<_>>();
        for asset in folded.assets.into_values() {
            if !live_file_ids.contains(asset.id.as_str()) {
                continue;
            }
            if scene_asset_ref_is_owned(directory, &asset.path, &asset.sha256) {
                assets.insert(asset.path, asset.sha256);
            }
        }
    }
    Ok(assets)
}

fn scene_asset_owner_scopes(
    conn: &Connection,
    key: &DocKey,
) -> Result<Vec<(String, String)>, CollabError> {
    let mut scopes = Vec::new();
    let mut seen_versions = HashSet::new();
    let mut version = Some(key.version_id.clone());
    while let Some(current) = version {
        if !seen_versions.insert(current.clone()) {
            return Err(CollabError::Corrupt {
                reason: "version ancestry contains a cycle".to_owned(),
            });
        }
        let directory = scene_asset_directory(&key.workspace_id, &current, &key.object_id)
            .map_err(|error| CollabError::Corrupt {
                reason: error.to_string(),
            })?;
        scopes.push((current.clone(), directory));
        version = conn
            .query_row(
                "SELECT fork_version_id FROM versions WHERE workspace_id=?1 AND version_id=?2",
                params![key.workspace_id, current],
                |row| row.get(0),
            )
            .map_err(corrupt)?;
    }
    Ok(scopes)
}

fn corrupt(error: rusqlite::Error) -> CollabError {
    CollabError::Storage(StorageError::corrupt_public(error))
}

fn persist(error: rusqlite::Error) -> CollabError {
    CollabError::Storage(StorageError::persist_public(error))
}
