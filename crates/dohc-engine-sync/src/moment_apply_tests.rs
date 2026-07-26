use dohc_engine_domain::{RollbackTextFileMutation, VersionedTextStore};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256, put_binary_blob};
use dohc_engine_testkit::ScratchDir;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    ApplyOutcome, ReplicationEnvelope, SyncError, apply_moment_envelope,
    apply_replication_envelope, read_replication_acked_seq,
};

fn test_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&path, 1_000).expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn envelope(origin: &str, seq: i64, workspace_id: &str, payload: Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: workspace_id.to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload,
        recorded_at_ms: 2_000 + seq,
    }
}

fn text_sha(text: &str) -> String {
    hex_sha256(text.as_bytes())
}

fn hydrate_texts(store: &mut EngineStore, texts: &[&str]) {
    store
        .read_with(|tx| {
            for text in texts {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![text_sha(text), text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate text blobs");
}

fn seed_text_moment(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    before: Option<(&str, &str)>,
    materialize_head: bool,
) {
    hydrate_texts(store, &[text]);
    if let Some((_, before_text)) = before {
        hydrate_texts(store, &[before_text]);
    }
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )?;
            let order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let (before_present, before_sha, before_id) = before.map_or(
                (1_i64, None, None),
                |(before_id, before_text)| {
                    (
                        2_i64,
                        Some(text_sha(before_text)),
                        Some(before_id.to_owned()),
                    )
                },
            );
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,?5,'write',?6,?7,?8,?9,
                           'api',NULL,NULL,'text',NULL,'text',NULL)",
                params![
                    order,
                    moment_id,
                    object_id,
                    path,
                    100 + order,
                    text_sha(text),
                    before_present,
                    before_sha,
                    before_id
                ],
            )?;
            if materialize_head {
                tx.execute(
                    "INSERT INTO snapshots (
                       workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                       latest_moment_id,metadata_origin,content_kind,binary_sha256
                     ) VALUES ('ws','main',?1,?2,?3,?4,?5,'api','text',NULL)
                     ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET
                       path=excluded.path,blob_sha256=excluded.blob_sha256,
                       updated_at_ms=excluded.updated_at_ms,
                       latest_moment_id=excluded.latest_moment_id,
                       metadata_origin=excluded.metadata_origin,content_kind='text',
                       binary_sha256=NULL",
                    params![object_id, path, text_sha(text), 100 + order, moment_id],
                )?;
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                     VALUES ('ws','main',?1,?2)
                     ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
                    params![path, object_id],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed text moment");
}

fn seed_text_lineage(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    base_text: &str,
    base_id: &str,
    head_text: &str,
    head_id: &str,
) {
    seed_text_moment(store, object_id, path, base_text, base_id, None, false);
    seed_text_moment(
        store,
        object_id,
        path,
        head_text,
        head_id,
        Some((base_id, base_text)),
        true,
    );
}

fn seed_binary_head(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    bytes: &[u8],
    moment_id: &str,
) -> String {
    let actual = hex_sha256(bytes);
    let stored = store
        .read_with(|tx| {
            let stored = put_binary_blob(tx, bytes)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            let order: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,100,'write',NULL,1,NULL,NULL,
                           'api',NULL,NULL,'binary',?5,'text',NULL)",
                params![order, moment_id, object_id, path, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO snapshots (
                   workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                   latest_moment_id,metadata_origin,content_kind,binary_sha256
                 ) VALUES ('ws','main',?1,?2,NULL,100,?3,'api','binary',?4)",
                params![object_id, path, moment_id, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                 VALUES ('ws','main',?1,?2)",
                params![path, object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(stored)
        })
        .expect("seed binary head");
    assert_eq!(stored, actual);
    actual
}

fn absent_text_payload(moment_id: &str, object_id: &str, path: &str, text: &str) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": text_sha(text),
        "payloadAfterPath": path,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    })
}

#[allow(clippy::too_many_arguments)]
fn present_text_payload(
    moment_id: &str,
    object_id: &str,
    operation: &str,
    path: &str,
    after_path: &str,
    before_text: &str,
    before_head: &str,
    after_text: &str,
) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": operation,
        "payloadBeforeBlobSha256": text_sha(before_text),
        "payloadBeforePath": path,
        "payloadAfterBlobSha256": text_sha(after_text),
        "payloadAfterPath": after_path,
        "metadata": {"origin": "sync", "summary": "peer"},
        "beforePresent": "present",
        "beforeObjectId": object_id,
        "beforeVersionId": "main",
        "beforePath": path,
        "beforeBlobSha256": text_sha(before_text),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": before_head,
        "beforeMetadata": {"origin": "api"}
    })
}

fn snapshot(store: &EngineStore, object_id: &str) -> Option<(String, String, String, String)> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT path,COALESCE(content_kind,'text'),
                        COALESCE(blob_sha256,binary_sha256),latest_moment_id
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
        })
        .expect("snapshot")
}

fn aliases(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM path_aliases WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| row.get(0))?
            .collect()
        })
        .expect("aliases")
}

fn indexed(store: &EngineStore, object_id: &str) -> Vec<(String, String)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,text FROM engine_search_files_fts \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .expect("search rows")
}

fn conflict_ids(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' ORDER BY conflict_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .expect("conflict ids")
}

#[test]
fn moment_append_head_fast_forward_write_delete_and_rename_updates_alias_snapshot_and_search() {
    let (_scratch, mut write_store) = test_store();
    hydrate_texts(&mut write_store, &["written"]);
    let write = envelope(
        "write-peer",
        0,
        "ws",
        absent_text_payload("remote-write", "object-write", "write.md", "written"),
    );
    assert_eq!(
        apply_moment_envelope(&mut write_store, &write, &NoFaults).expect("write"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(
        snapshot(&write_store, "object-write"),
        Some((
            "write.md".to_owned(),
            "text".to_owned(),
            text_sha("written"),
            "remote-write".to_owned()
        ))
    );
    assert_eq!(aliases(&write_store, "object-write"), ["write.md"]);
    assert_eq!(
        indexed(&write_store, "object-write"),
        [("write.md".to_owned(), "written".to_owned())]
    );

    let (_scratch, mut delete_store) = test_store();
    seed_text_moment(
        &mut delete_store,
        "object-delete",
        "delete.md",
        "gone",
        "local-delete-head",
        None,
        true,
    );
    delete_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-delete','delete.md','gone')",
                [],
            )
        })
        .expect("seed search");
    let delete = envelope(
        "delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "object-delete",
            "delete",
            "delete.md",
            "delete.md",
            "gone",
            "local-delete-head",
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut delete_store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(snapshot(&delete_store, "object-delete"), None);
    assert!(aliases(&delete_store, "object-delete").is_empty());
    assert!(indexed(&delete_store, "object-delete").is_empty());

    let (_scratch, mut rename_store) = test_store();
    seed_text_moment(
        &mut rename_store,
        "object-rename",
        "old.md",
        "same",
        "local-rename-head",
        None,
        true,
    );
    rename_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-rename','old.md','same')",
                [],
            )
        })
        .expect("seed search");
    let rename = envelope(
        "rename-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "object-rename",
            "rename",
            "old.md",
            "new.md",
            "same",
            "local-rename-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut rename_store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(aliases(&rename_store, "object-rename"), ["new.md"]);
    assert_eq!(
        snapshot(&rename_store, "object-rename").unwrap().0,
        "new.md"
    );
    assert_eq!(
        indexed(&rename_store, "object-rename"),
        [("new.md".to_owned(), "same".to_owned())]
    );
}

#[test]
fn moment_append_content_fast_forward_converges_text_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "converged",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "converged"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-before",
            "remote-before-head",
            "converged",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("converge"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "remote-head");
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_content_fast_forward_converges_binary_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    let bytes = b"\0same binary\xff";
    let sha = seed_binary_head(&mut store, "binary-object", "same.bin", bytes, "local-bin");
    let payload = json!({
        "momentId": "remote-bin",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "same.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": sha,
        "payloadBeforePath": "same.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": bytes.len(),
        "payloadAfterBlobSha256": sha,
        "payloadAfterPath": "same.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": bytes.len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "present",
        "beforeObjectId": "binary-object",
        "beforeVersionId": "main",
        "beforePath": "same.bin",
        "beforeBlobSha256": sha,
        "beforeContentKind": "binary",
        "beforeByteLength": bytes.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before-bin",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("binary converge"),
        ApplyOutcome::Applied(0)
    );
    let head = snapshot(&store, "binary-object").unwrap();
    assert_eq!(head.0, "same.bin");
    assert_eq!(head.1, "binary");
    assert_eq!(head.2, sha);
    assert_eq!(head.3, "remote-bin");
    assert!(indexed(&store, "binary-object").is_empty());
}

#[test]
fn moment_append_same_bytes_at_a_different_path_conflicts_instead_of_converging() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "local.md",
        "same bytes",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "same bytes"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "rename",
            "remote-old.md",
            "remote.md",
            "remote-before",
            "remote-before-head",
            "same bytes",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::Applied(1)
    );
    assert_eq!(snapshot(&store, "object").unwrap().0, "local.md");
    assert_eq!(conflict_ids(&store).len(), 1);
}

#[test]
fn moment_append_content_convergent_adoption_localizes_rollback_but_keeps_wire_payload() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-old", "agreed"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-adopted",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-old",
            "remote-old-head",
            "agreed",
        ),
    );
    let wire = op.payload_json().expect("wire json");
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("adopt"),
        ApplyOutcome::Applied(0)
    );
    store
        .read_with(|conn| {
            let before: (String, String, Option<i64>) = conn.query_row(
                "SELECT before_blob_sha256,before_latest_moment_id,sync_record_only \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(before.0, text_sha("agreed"));
            assert_eq!(before.1, "local-head");
            assert_eq!(before.2, None);
            let journal: String = conn.query_row(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(journal, wire);
            Ok::<_, rusqlite::Error>(())
        })
        .expect("adopted row");
}

#[test]
fn moment_append_both_sides_deleted_is_record_only_and_touches_no_search_state() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["deleted"]);
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','deleted-object','deleted.md','stale sentinel')",
                [],
            )
        })
        .expect("search sentinel");
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "deleted-object",
            "delete",
            "deleted.md",
            "deleted.md",
            "deleted",
            "remote-before",
            "deleted",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("both deleted"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(snapshot(&store, "deleted-object"), None);
    assert_eq!(
        indexed(&store, "deleted-object"),
        [("deleted.md".to_owned(), "stale sentinel".to_owned())]
    );
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-delete'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_divergence_opens_one_duplicate_envelope_skips_and_next_head_coalesces() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(
        &mut store,
        &["base", "payload-before", "remote-one", "remote-two"],
    );
    let mut first_payload = present_text_payload(
        "remote-root",
        "object",
        "write",
        "doc.md",
        "doc.md",
        "base",
        "base-moment",
        "remote-one",
    );
    first_payload["payloadBeforeBlobSha256"] = json!(text_sha("payload-before"));
    first_payload["payloadBeforePath"] = json!("payload-before.md");
    let first = envelope("peer", 0, "ws", first_payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::Applied(1)
    );
    store
        .read_with(|conn| {
            let base: (i64, String, Option<String>, String, Option<String>) = conn.query_row(
                "SELECT base_exists,base_path,base_object_id,base_blob_sha256,
                        base_latest_moment_id
                 FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(
                base,
                (
                    1,
                    "doc.md".to_owned(),
                    Some("object".to_owned()),
                    text_sha("base"),
                    Some("base-moment".to_owned())
                )
            );
            Ok::<_, rusqlite::Error>(())
        })
        .expect("wire before conflict base");
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("duplicate envelope"),
        ApplyOutcome::Skipped
    );
    let second = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "remote-next",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "remote-one",
            "remote-root",
            "remote-two",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &second, &NoFaults).expect("coalesce"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(conflict_ids(&store).len(), 1);
    let incoming: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT incoming_latest_moment_id FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("incoming head");
    assert_eq!(incoming, "remote-next");
}

#[test]
fn moment_append_deterministic_conflict_id_is_identical_when_branch_roots_are_swapped() {
    let (_a, mut left) = test_store();
    let (_b, mut right) = test_store();
    seed_text_lineage(
        &mut left,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "left",
        "left-root",
    );
    seed_text_lineage(
        &mut right,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "right",
        "right-root",
    );
    hydrate_texts(&mut left, &["base", "right"]);
    hydrate_texts(&mut right, &["base", "left"]);
    let right_into_left = envelope(
        "right-peer",
        0,
        "ws",
        present_text_payload(
            "right-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "right",
        ),
    );
    let left_into_right = envelope(
        "left-peer",
        0,
        "ws",
        present_text_payload(
            "left-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "left",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut left, &right_into_left, &NoFaults).expect("left"),
        ApplyOutcome::Applied(1)
    );
    assert_eq!(
        apply_moment_envelope(&mut right, &left_into_right, &NoFaults).expect("right"),
        ApplyOutcome::Applied(1)
    );
    assert_eq!(conflict_ids(&left), conflict_ids(&right));
    assert_eq!(conflict_ids(&left).len(), 1);
}

#[test]
fn moment_append_occupancy_divergence_returns_two_distinct_conflicts() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "mover",
        "source.md",
        "base",
        "base-moment",
        "local mover",
        "local-root",
    );
    seed_text_moment(
        &mut store,
        "occupant",
        "destination.md",
        "occupied",
        "occupant-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["base", "incoming mover"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-move",
            "mover",
            "rename",
            "source.md",
            "destination.md",
            "base",
            "base-moment",
            "incoming mover",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("occupancy"),
        ApplyOutcome::Applied(2)
    );
    let ids = conflict_ids(&store);
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(snapshot(&store, "mover").unwrap().0, "source.md");
    assert_eq!(snapshot(&store, "occupant").unwrap().0, "destination.md");
}

#[test]
fn moment_append_record_only_divergence_is_not_a_head_and_cannot_be_rolled_back() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(&mut store, &["base", "remote"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-record-only",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "remote",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::Applied(1)
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "local-root");
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-record-only'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    let error = VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "remote-record-only".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect_err("record-only rollback");
    assert_eq!(error.code(), "invalid-input");
}

#[test]
fn moment_append_duplicate_moment_id_is_applied_and_acked_but_duplicate_envelope_is_skipped() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["first"]);
    let first = envelope(
        "first-peer",
        0,
        "ws",
        absent_text_payload("shared-moment", "object", "doc.md", "first"),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::Applied(0)
    );
    let duplicate_id = envelope(
        "second-peer",
        0,
        "ws",
        absent_text_payload(
            "shared-moment",
            "other-object",
            "other.md",
            "missing blob is never hydrated",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &duplicate_id, &NoFaults).expect("duplicate id"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "second-peer").expect("ack"),
        0
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &duplicate_id, &NoFaults).expect("duplicate envelope"),
        ApplyOutcome::Skipped
    );
    let journal_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND op_kind='moment.append'",
                [],
                |row| row.get(0),
            )
        })
        .expect("journal count");
    assert_eq!(journal_count, 2);
}

#[test]
fn moment_append_requires_version_create_ordering_and_never_acks_a_missing_target() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let mut payload = absent_text_payload("moment", "object", "doc.md", "content");
    payload["versionId"] = json!("missing");
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_replication_envelope(&mut store, &op, &NoFaults, &crate::NoLiveLeases),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_non_tracked_or_noncanonical_paths_before_mutation() {
    let mut secret_after = absent_text_payload(
        "secret-after",
        "secret-after-object",
        "docs/safe.md",
        "content",
    );
    secret_after["payloadAfterPath"] = json!("app/.env");

    let mut noncanonical_path = absent_text_payload(
        "noncanonical-path",
        "noncanonical-path-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_path["path"] = json!("a//b.md");

    let mut noncanonical_after = absent_text_payload(
        "noncanonical-after",
        "noncanonical-after-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_after["payloadAfterPath"] = json!("a//b.md");

    let mut secret_before = absent_text_payload(
        "secret-before",
        "secret-before-object",
        "docs/new.md",
        "content",
    );
    secret_before["payloadBeforePath"] = json!("app/.env");
    secret_before["payloadBeforeBlobSha256"] = json!(text_sha("content"));

    let mut secret_before_snapshot = present_text_payload(
        "secret-before-snapshot",
        "secret-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    secret_before_snapshot["beforePath"] = json!("app/.env");

    let mut noncanonical_before_snapshot = present_text_payload(
        "noncanonical-before-snapshot",
        "noncanonical-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    noncanonical_before_snapshot["beforePath"] = json!("a//b.md");

    for (case, payload, object_id) in [
        (
            "secret payloadAfterPath",
            secret_after,
            "secret-after-object",
        ),
        (
            "noncanonical path",
            noncanonical_path,
            "noncanonical-path-object",
        ),
        (
            "noncanonical payloadAfterPath",
            noncanonical_after,
            "noncanonical-after-object",
        ),
        (
            "secret payloadBeforePath",
            secret_before,
            "secret-before-object",
        ),
        (
            "secret beforePath",
            secret_before_snapshot,
            "secret-before-snapshot-object",
        ),
        (
            "noncanonical beforePath",
            noncanonical_before_snapshot,
            "noncanonical-before-snapshot-object",
        ),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let op = envelope("peer", 0, "ws", payload);
        let error = match apply_moment_envelope(&mut store, &op, &NoFaults) {
            Ok(outcome) => panic!("{case} unexpectedly applied as {outcome:?}"),
            Err(error) => error,
        };
        assert!(
            matches!(error, SyncError::InvalidInput { .. }),
            "{case} must be malformed input, got {error:?}"
        );
        let persisted: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("rejected path leaves no rows");
        assert_eq!(persisted, (0, 0, 0), "{case} persisted poisoned rows");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            -1,
            "{case} advanced the peer ack"
        );
    }

    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let canonical = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "canonical",
            "canonical-object",
            "docs/canonical.md",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical, &NoFaults).expect("canonical tracked path"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(
        snapshot(&store, "canonical-object").unwrap().0,
        "docs/canonical.md"
    );
    assert_eq!(
        aliases(&store, "canonical-object"),
        ["docs/canonical.md".to_owned()]
    );

    let canonical_before = envelope(
        "canonical-before-peer",
        0,
        "ws",
        present_text_payload(
            "canonical-before",
            "canonical-before-object",
            "write",
            "docs/canonical-before.md",
            "docs/canonical-after.md",
            "content",
            "remote-base",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical_before, &NoFaults)
            .expect("canonical tracked beforePath"),
        ApplyOutcome::Applied(1)
    );
}

#[test]
fn moment_append_persists_full_wire_payload_provenance() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "docs/new.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    let remote_before = b"\0remote binary preimage\xff";
    let remote_before_sha = store
        .read_with(|conn| put_binary_blob(conn, remote_before))
        .expect("remote before blob");
    let after_sha = text_sha("agreed");
    let payload = json!({
        "momentId": "remote-adopted",
        "versionId": "main",
        "objectId": "object",
        "objectCreatedAtMs": 1,
        "path": "remote/old.bin",
        "recordedAtMs": 2_000,
        "operation": "rename",
        "payloadBeforeBlobSha256": remote_before_sha,
        "payloadBeforePath": "remote/old.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": remote_before.len(),
        "payloadAfterBlobSha256": after_sha,
        "payloadAfterPath": "docs/new.md",
        "payloadAfterContentKind": "text",
        "payloadAfterByteLength": "agreed".len(),
        "metadata": {
            "origin": "sync",
            "summary": "adopted from peer",
            "correlationId": "correlation-remote-adopted"
        },
        "beforePresent": "present",
        "beforeObjectId": "object",
        "beforeVersionId": "main",
        "beforePath": "remote/old.bin",
        "beforeBlobSha256": remote_before_sha,
        "beforeContentKind": "binary",
        "beforeByteLength": remote_before.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("content-convergent adoption"),
        ApplyOutcome::Applied(0)
    );

    let provenance = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_before_path,payload_before_content_kind,
                        payload_before_blob_sha256,payload_after_path,
                        payload_after_content_kind,payload_after_blob_sha256
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
        })
        .expect("payload provenance");
    assert_eq!(
        provenance,
        (
            Some("remote/old.bin".to_owned()),
            Some("binary".to_owned()),
            Some(remote_before_sha),
            Some("docs/new.md".to_owned()),
            Some("text".to_owned()),
            Some(after_sha),
        )
    );

    let metadata = store
        .read_with(|conn| {
            let moment = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            let snapshot = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM snapshots WHERE workspace_id='ws' AND object_id='object'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            Ok::<_, rusqlite::Error>((moment, snapshot))
        })
        .expect("replicated metadata");
    let expected = (
        "sync".to_owned(),
        Some("adopted from peer".to_owned()),
        Some("correlation-remote-adopted".to_owned()),
    );
    // MUTATION: dropping either optional field from the moment or snapshot
    // insert makes one side of this round trip differ.
    assert_eq!(metadata, (expected.clone(), expected));
}

#[test]
fn moment_append_search_index_respects_files_and_visibility_policy() {
    let (scratch, mut store) = test_store();
    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "[[rule]]\npath = \"private/**\"\nsearchable = false\n",
    )
    .expect("files policy");
    std::fs::write(
        scratch.path().join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"hidden/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("visibility policy");
    hydrate_texts(
        &mut store,
        &["private needle", "hidden needle", "public needle"],
    );

    for (origin, moment_id, object_id, path, text) in [
        (
            "private-peer",
            "private-moment",
            "private-object",
            "private/doc.md",
            "private needle",
        ),
        (
            "hidden-peer",
            "hidden-moment",
            "hidden-object",
            "hidden/doc.md",
            "hidden needle",
        ),
        (
            "public-peer",
            "public-moment",
            "public-object",
            "public/doc.md",
            "public needle",
        ),
    ] {
        let op = envelope(
            origin,
            0,
            "ws",
            absent_text_payload(moment_id, object_id, path, text),
        );
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("policy-aware apply"),
            ApplyOutcome::Applied(0)
        );
    }

    // MUTATION: removing or inverting either policy predicate indexes one of
    // the excluded rows; skipping the healthy insert loses the public row.
    assert!(indexed(&store, "private-object").is_empty());
    assert!(indexed(&store, "hidden-object").is_empty());
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );
}

#[test]
fn moment_append_rejects_each_incomplete_payload_before_tuple_without_ack() {
    for (case, before_path, before_sha) in [
        ("path only", Some("doc.md"), None),
        ("digest only", None, Some(text_sha("before"))),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["before", "after"]);
        let mut payload = absent_text_payload("tuple-moment", "tuple-object", "doc.md", "after");
        payload["payloadBeforePath"] = before_path.map_or(Value::Null, |path| json!(path));
        payload["payloadBeforeBlobSha256"] = before_sha.map_or(Value::Null, |sha| json!(sha));
        let op = envelope("tuple-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Err(SyncError::InvalidInput { .. })
            ),
            "{case} must be rejected"
        );
        let rows: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                     AND object_id='tuple-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("moment count");
        assert_eq!(rows, 0, "{case} mutated moment history");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "tuple-peer").expect("ack"),
            -1,
            "{case} advanced the peer ack"
        );
    }
}

#[test]
fn replicated_delete_after_path_divergent_rename_removes_the_live_alias() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["same"]);
    seed_text_moment(
        &mut store,
        "rename-delete-object",
        "old.md",
        "same",
        "local-head",
        None,
        true,
    );
    let rename = envelope(
        "rename-delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "rename-delete-object",
            "rename",
            "old.md",
            "new.md",
            "same",
            "local-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::Applied(0)
    );
    assert_eq!(
        aliases(&store, "rename-delete-object"),
        ["new.md".to_owned()]
    );

    let delete = envelope(
        "rename-delete-peer",
        1,
        "ws",
        present_text_payload(
            "remote-delete",
            "rename-delete-object",
            "delete",
            "old.md",
            "old.md",
            "same",
            "remote-rename",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::Applied(0)
    );
    // MUTATION: deleting by the remote payload path leaves `new.md` behind.
    assert!(aliases(&store, "rename-delete-object").is_empty());
    assert_eq!(snapshot(&store, "rename-delete-object"), None);
}

#[test]
fn moment_append_rejects_overlong_moment_and_object_ids_without_ack() {
    for (case, field) in [("moment id", "momentId"), ("object id", "objectId")] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let mut payload =
            absent_text_payload("bounded-moment", "bounded-object", "doc.md", "content");
        payload[field] = json!("x".repeat(crate::model::MAX_IDENTIFIER_BYTES + 1));
        let op = envelope("bounded-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Err(SyncError::InvalidInput { .. })
            ),
            "overlong {case} must be rejected"
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "bounded-peer").expect("ack"),
            -1,
            "overlong {case} advanced the peer ack"
        );
    }
}

#[test]
fn moment_append_rejects_a_poisoned_binary_blob_as_storage_corruption_before_mutation() {
    let (_scratch, mut store) = test_store();
    let claimed = hex_sha256(b"honest binary");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                params![claimed, b"poisoned".len() as i64, b"poisoned".as_slice()],
            )
        })
        .expect("poison binary blob");
    let payload = json!({
        "momentId": "binary-moment",
        "versionId": "main",
        "objectId": "binary-object",
        "objectCreatedAtMs": 1,
        "path": "assets/file.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": claimed,
        "payloadAfterPath": "assets/file.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": b"honest binary".len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("poisoned binary blob must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. })
        ),
        "local blob corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='binary-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed binary apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_require_blob_text_rejects_a_poisoned_address_before_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'poisoned')",
                params![claimed, "poisoned".len() as i64],
            )
        })
        .expect("poison blob");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload("moment", "object", "doc.md", "honest"),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_a_corrupt_text_blob_length_before_mutation_and_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'honest')",
                params![claimed, "honest".len() as i64 + 1],
            )
        })
        .expect("poison blob length");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "corrupt-length-moment",
            "corrupt-length-object",
            "doc.md",
            "honest",
        ),
    );
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("corrupt text blob length must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::StateCorrupt { .. })
        ),
        "local length corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' AND moment_id='corrupt-length-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed text apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_an_empty_binary_digest_as_storage_corruption_even_if_hydrated() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES ('',0,X'')",
                [],
            )
        })
        .expect("empty-key binary row");
    let payload = json!({
        "momentId": "bad-binary",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "bad.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": "",
        "payloadAfterPath": "bad.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": 0,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}
