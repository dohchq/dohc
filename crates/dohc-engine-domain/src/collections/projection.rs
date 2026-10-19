use super::*;
use dohc_engine_storage::text;

/// Disposable hashes and parsed schemas for a received share's local index.
/// A new worker rebuilds the index from snapshots, including on existing stores.
#[derive(Clone, Default)]
pub struct CollectionProjection {
    version_id: Option<String>,
    heads: BTreeMap<String, (String, String)>,
    schemas: HashMap<String, CollectionSchemaParseResult>,
    duplicates: BTreeMap<String, String>,
}

/// Project settled snapshots without adopting files, recording history, or
/// creating automation claims. Only changed artifacts are read and parsed.
pub fn project_collections_in_tx(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
    previous: CollectionProjection,
) -> Result<(CollectionProjection, Vec<String>), crate::DomainError> {
    // A received binding and its no-history guard must become visible together.
    let received: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM share_view_cursors WHERE workspace_id=?1)",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    if !received {
        return Ok((previous, Vec::new()));
    }
    let mut next = if previous.version_id.as_deref() == Some(version_id) {
        previous
    } else {
        for table in [
            "collection_record_fields",
            "collection_relation_edges",
            "collection_records",
            "collections",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE workspace_id=?1 AND version_id=?2"),
                params![workspace_id, version_id],
            )
            .map_err(crate::DomainError::sql_persist)?;
        }
        CollectionProjection {
            version_id: Some(version_id.to_owned()),
            ..Default::default()
        }
    };
    let mut statement = tx
        .prepare(
            "SELECT path,object_id,blob_sha256 FROM snapshots \
         WHERE workspace_id=?1 AND version_id=?2 AND content_kind='text' \
           AND (path=?3 OR substr(path,-(length(?3)+1))='/'||?3 \
             OR lower(substr(path,-3))='.md') ORDER BY path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let heads = statement
        .query_map(
            params![workspace_id, version_id, COLLECTION_SCHEMA_FILENAME],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
                ))
            },
        )
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    drop(statement);
    let changed: HashSet<String> = heads
        .keys()
        .chain(next.heads.keys())
        .filter(|path| heads.get(*path) != next.heads.get(*path))
        .cloned()
        .collect();
    let changed_schemas: HashSet<String> = changed
        .iter()
        .filter(|path| path_basename(path) == COLLECTION_SCHEMA_FILENAME)
        .map(|path| parent_path(path).to_owned())
        .collect();
    let read_text = |hash: &str| -> Result<String, crate::DomainError> {
        text::read(tx, hash).map_err(crate::DomainError::sql_corrupt)
    };
    for collection_path in &changed_schemas {
        let schema_path = if collection_path.is_empty() {
            COLLECTION_SCHEMA_FILENAME.to_owned()
        } else {
            format!("{collection_path}/{COLLECTION_SCHEMA_FILENAME}")
        };
        next.schemas.remove(collection_path);
        if let Some((_, hash)) = heads.get(&schema_path) {
            let parsed = if collection_path.is_empty() {
                degraded_document(CollectionSchemaReasonCode::RootCollectionUnsupported)
            } else {
                parse_collection_schema(&read_text(hash)?)
            };
            let reasons = serde_json::to_string(&parsed.reasons).map_err(|error| {
                crate::DomainError::Storage(StorageError::persist_public(error))
            })?;
            tx.execute("INSERT INTO collections (workspace_id,version_id,collection_path,schema_path,schema_status,degradation_reasons_json) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,version_id,collection_path) DO UPDATE SET schema_path=excluded.schema_path,schema_status=excluded.schema_status,degradation_reasons_json=excluded.degradation_reasons_json",
                params![workspace_id, version_id, if collection_path.is_empty() { ROOT_COLLECTION_DIAGNOSTIC_PATH } else { collection_path }, schema_path,
                    if parsed.status == CollectionSchemaStatus::Valid { "valid" } else { "degraded" }, reasons])
                .map_err(crate::DomainError::sql_persist)?;
            next.schemas.insert(collection_path.clone(), parsed);
        }
    }
    let mut affected_records: BTreeMap<_, _> = heads
        .keys()
        .chain(next.heads.keys())
        .filter(|path| {
            is_collection_markdown_path(path)
                && (changed.contains(*path) || changed_schemas.contains(parent_path(path)))
        })
        .map(|path| (path.clone(), heads.get(path)))
        .collect();
    // Reconsider a duplicate only when its winning binding changes.
    let mut displaced_ids = HashSet::new();
    let mut old_bindings = HashMap::new();
    for path in affected_records.keys() {
        let old_id: Option<String> = tx.query_row(
            "SELECT record_id FROM collection_records WHERE workspace_id=?1 AND version_id=?2 AND file_path=?3",
            params![workspace_id, version_id, path], |row| row.get(0))
            .optional().map_err(crate::DomainError::sql_corrupt)?.flatten();
        displaced_ids.extend(old_id.clone());
        old_bindings.insert(path.clone(), old_id);
    }
    for (path, id) in &next.duplicates {
        if displaced_ids.contains(id) {
            affected_records.insert(path.clone(), heads.get(path));
        }
    }
    // Remove the old bindings together, so a rename retains the owner's id.
    for path in affected_records.keys() {
        if let Some(record_id) = old_bindings.remove(path).flatten() {
            tx.execute("DELETE FROM collection_record_fields WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
                params![workspace_id, version_id, record_id]).map_err(crate::DomainError::sql_persist)?;
            tx.execute("DELETE FROM collection_relation_edges WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3",
                params![workspace_id, version_id, record_id]).map_err(crate::DomainError::sql_persist)?;
        }
        tx.execute("DELETE FROM collection_records WHERE workspace_id=?1 AND version_id=?2 AND file_path=?3",
            params![workspace_id, version_id, path]).map_err(crate::DomainError::sql_persist)?;
    }
    for collection_path in &changed_schemas {
        if !next.schemas.contains_key(collection_path) {
            tx.execute("DELETE FROM collections WHERE workspace_id=?1 AND version_id=?2 AND collection_path=?3",
                params![workspace_id, version_id, if collection_path.is_empty() { ROOT_COLLECTION_DIAGNOSTIC_PATH } else { collection_path }])
                .map_err(crate::DomainError::sql_persist)?;
        }
    }
    let mut projected_paths: Vec<String> = changed_schemas
        .iter()
        .map(|path| {
            if path.is_empty() {
                COLLECTION_SCHEMA_FILENAME.to_owned()
            } else {
                format!("{path}/{COLLECTION_SCHEMA_FILENAME}")
            }
        })
        .collect();
    for (path, head) in affected_records {
        next.duplicates.remove(&path);
        let collection_path = parent_path(&path);
        let Some(parsed) = next.schemas.get(collection_path).filter(|parsed| {
            !collection_path.is_empty()
                && !parsed
                    .reasons
                    .iter()
                    .any(|reason| reason.code == CollectionSchemaReasonCode::UnsupportedVersion)
        }) else {
            continue;
        };
        projected_paths.push(path.clone());
        let Some((object_id, hash)) = head else {
            continue;
        };
        let text = read_text(hash)?;
        let Some(record_id) = markdown_record_id(&text).filter(|id| is_record_id(id)) else {
            continue;
        };
        let Some(frontmatter) = parse_markdown_frontmatter(&text) else {
            continue;
        };
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_records WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3)",
            params![workspace_id, version_id, record_id], |row| row.get(0)).map_err(crate::DomainError::sql_corrupt)?;
        if duplicate {
            next.duplicates.insert(path, record_id);
            continue;
        }
        tx.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) VALUES (?1,?2,?3,?4,?5,?6,'adopted',0)",
            params![workspace_id, version_id, record_id, collection_path, path, object_id]).map_err(crate::DomainError::sql_persist)?;
        replace_index_for_record(
            tx,
            workspace_id,
            version_id,
            &record_id,
            &parsed.schema,
            &frontmatter.value,
            FieldProvenance::Parsed {
                non_finite_fields: &frontmatter.non_finite_fields,
                unsupported_tag_fields: &frontmatter.unsupported_tag_fields,
            },
        )?;
    }
    next.heads = heads;
    projected_paths.sort();
    projected_paths.dedup();
    Ok((next, projected_paths))
}
