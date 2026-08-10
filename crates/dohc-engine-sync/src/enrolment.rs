//! Backfill rows this workspace locally originated before the live capture
//! path could journal them. Each row class derives its filter from that rule.
//!
//! Named-version payloads always read `fork_base_snapshots`. Named-version
//! creation freezes those rows from the same source as `snapshots` in the same
//! transaction, so the live caller gets identical bytes and delayed backfill
//! keeps the fork-time state.

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{SecretMomentRecord, SecretOp, VersionKind, VersionRecord};
use rusqlite::{Row, Transaction, params};

use crate::{
    BaseOrigination, SharingDeclined, SyncError, journal_moment_append_in_tx,
    journal_secret_delete_in_tx, journal_secret_put_from_moment_in_tx,
    journal_secret_version_fork_in_tx, journal_version_create_in_tx, originate_ydoc_base_in_tx,
};

pub(crate) fn backfill_enrolment_window_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<Vec<SharingDeclined>, SyncError> {
    backfill_versions(tx, workspace_id)?;
    let sharing_declined = backfill_ydoc_bases(tx, workspace_id, now_ms)?;
    backfill_moments(tx, workspace_id)?;
    backfill_secret_moments(tx, workspace_id)?;
    Ok(sharing_declined)
}

fn backfill_ydoc_bases(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<Vec<SharingDeclined>, SyncError> {
    let rows: Vec<(String, String, String)> = collect_rows(
        tx,
        "SELECT d.version_id, d.object_id, s.path FROM ydoc_docs d \
         JOIN snapshots s ON s.workspace_id=d.workspace_id \
           AND s.version_id=d.version_id AND s.object_id=d.object_id \
         WHERE d.workspace_id=?1 AND d.base_claimed=0 \
         ORDER BY d.version_id, d.object_id",
        workspace_id,
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut sharing_declined = Vec::new();
    for (version_id, object_id, path) in rows {
        let key = DocKey {
            workspace_id: workspace_id.to_owned(),
            version_id,
            object_id,
        };
        if let BaseOrigination::Declined(declined) =
            originate_ydoc_base_in_tx(tx, &key, &path, now_ms)?
        {
            sharing_declined.push(declined);
        }
    }
    Ok(sharing_declined)
}

fn backfill_moments(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    let moment_ids = collect_ids(
        tx,
        "SELECT moment_id FROM moments \
         WHERE workspace_id=?1 AND metadata_origin='capture' \
         ORDER BY moment_order",
        workspace_id,
    )?;
    for moment_id in moment_ids {
        journal_moment_append_in_tx(tx, workspace_id, &moment_id)?;
    }
    Ok(())
}

fn backfill_versions(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    type VersionRow = (String, String, String, i64, Option<String>, Option<String>);
    let raw_records: Vec<VersionRow> = collect_rows(
        tx,
        "SELECT v.version_id, v.kind, v.name, v.created_at_ms, \
                    v.fork_version_id, v.fork_moment_id \
             FROM versions v \
             WHERE v.workspace_id=?1 AND v.kind='named' \
               AND NOT EXISTS (SELECT 1 FROM replication_log r \
                 WHERE r.workspace_id=?1 AND r.op_kind='version.create' \
                   AND json_extract(r.payload_json,'$.versionId')=v.version_id) \
             ORDER BY v.created_at_ms, v.version_id",
        workspace_id,
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
    )?;
    let records = raw_records
        .into_iter()
        .map(
            |(version_id, raw_kind, name, created_at_ms, fork_version_id, fork_moment_id)| {
                Ok(VersionRecord {
                    workspace_id: workspace_id.to_owned(),
                    version_id,
                    kind: VersionKind::from_db(&raw_kind).map_err(SyncError::corrupt)?,
                    name,
                    created_at_ms,
                    fork_version_id,
                    fork_moment_id,
                })
            },
        )
        .collect::<Result<Vec<_>, SyncError>>()?;
    for record in records {
        journal_version_create_in_tx(tx, &record)?;
        if let Some(from_version_id) = &record.fork_version_id {
            journal_secret_version_fork_in_tx(
                tx,
                &record.workspace_id,
                from_version_id,
                &record.version_id,
                record.created_at_ms,
            )?;
        }
    }
    Ok(())
}

fn backfill_secret_moments(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    type SecretRow = (
        i64,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    );
    let rows: Vec<SecretRow> = collect_rows(
        tx,
        "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                operation, metadata_origin, metadata_summary, metadata_correlation_id, \
                after_iv_base64, after_auth_tag_base64, after_ciphertext_base64, \
                after_byte_length \
         FROM secret_moments \
         WHERE workspace_id=?1 AND moment_id NOT LIKE 'secret-sync-%' \
         ORDER BY moment_order",
        workspace_id,
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
            ))
        },
    )?;
    for row in rows {
        let record = SecretMomentRecord {
            moment_order: row.0,
            moment_id: row.1,
            workspace_id: row.2,
            version_id: row.3,
            path: row.4,
            recorded_at_ms: row.5,
            operation: SecretOp::from_db(&row.6).map_err(SyncError::corrupt)?,
            metadata_origin: row.7,
            metadata_summary: row.8,
            metadata_correlation_id: row.9,
        };
        match record.operation {
            SecretOp::Write => journal_secret_put_from_moment_in_tx(
                tx,
                &record,
                row.10.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained iv",
                    ))
                })?,
                row.11.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained auth tag",
                    ))
                })?,
                row.12.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained ciphertext",
                    ))
                })?,
                row.13.ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained byte length",
                    ))
                })?,
            )?,
            SecretOp::Delete => journal_secret_delete_in_tx(tx, &record)?,
        }
    }
    Ok(())
}

fn collect_ids(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    let mut statement = tx.prepare(sql).map_err(SyncError::corrupt)?;
    statement
        .query_map(params![workspace_id], |row| row.get(0))
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
}

fn collect_rows<T, F>(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
    map: F,
) -> Result<Vec<T>, SyncError>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = tx.prepare(sql).map_err(SyncError::corrupt)?;
    statement
        .query_map([workspace_id], map)
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
    use dohc_engine_domain::{CreateNamedVersion, VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::params;

    use super::*;

    fn store() -> (ScratchDir, EngineStore) {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        let store = EngineStore::open(&path, 1_000).expect("open store");
        (scratch, store)
    }

    fn seed_main(store: &mut EngineStore) {
        VersionedTextStore::new(store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("main version");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_identity \
                     (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                     VALUES ('ws','local','epoch','stream',1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("identity");
    }

    fn write_text(
        store: &mut EngineStore,
        version_id: &str,
        object_id: &str,
        moment_id: &str,
        text: &str,
        origin: &str,
        now_ms: i64,
    ) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: version_id.to_owned(),
                    object_id: object_id.to_owned(),
                    path: format!("{object_id}.md"),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: if origin == "capture" {
                        "api".to_owned()
                    } else {
                        origin.to_owned()
                    },
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write text");
        if origin == "capture" {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE moments SET metadata_origin='capture' \
                         WHERE workspace_id='ws' AND moment_id=?1",
                        [moment_id],
                    )
                    .map_err(SyncError::persist)?;
                    tx.execute(
                        "UPDATE snapshots SET metadata_origin='capture' \
                         WHERE workspace_id='ws' AND version_id=?1 AND object_id=?2",
                        params![version_id, object_id],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("stamp autonomous capture origin");
        }
    }

    fn enroll(store: &mut EngineStore) -> Result<(), SyncError> {
        match store.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws','local',-1)",
                [],
            )
            .map_err(SyncError::persist)?;
            backfill_enrolment_window_in_tx(tx, "ws", 1_000)
        })? {
            dohc_engine_storage::TxnOutcome::Committed(_) => Ok(()),
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
    }

    fn local_ops(store: &EngineStore) -> Vec<(String, serde_json::Value)> {
        store
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT op_kind,payload_json FROM replication_log \
                     WHERE workspace_id='ws' AND imported=0 ORDER BY origin_seq",
                )?;
                statement
                    .query_map([], |row| {
                        let payload: String = row.get(1)?;
                        Ok((
                            row.get::<_, String>(0)?,
                            serde_json::from_str(&payload).expect("payload json"),
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("local ops")
    }

    #[test]
    fn pull_imported_moments_are_not_echoed_by_enrolment() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "imported",
            "moment-imported",
            "peer",
            "sync",
            10,
        );

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "moment.append"),
            "an imported moment must not be journaled under the receiver's origin"
        );
    }

    #[test]
    fn ydoc_projection_moments_are_excluded_while_the_base_is_backfilled() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "ydoc-object",
            "moment-ydoc-projection",
            "projected",
            "ydoc",
            10,
        );
        let key = DocKey::new("ws", "main", "ydoc-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "projected");
        dohc_engine_collab::record_local_update_creating_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            &NoFaults,
            11,
        )
        .expect("record local ydoc update");

        enroll(&mut store).expect("enroll");

        let ops = local_ops(&store);
        assert_eq!(
            ops.iter().filter(|(kind, _)| kind == "ydoc.update").count(),
            1,
            "the CRDT base is the one replicated source of truth"
        );
        assert_eq!(
            ops.iter()
                .filter(|(kind, _)| kind == "moment.append")
                .count(),
            0,
            "the derived Markdown projection must not compete with its CRDT base"
        );

        let base_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload))
            .expect("backfilled Y.Doc base");
        let update_sha = base_payload["updateBlobSha256"]
            .as_str()
            .expect("update blob sha");
        let update_bytes = store
            .get_binary_blob(update_sha)
            .expect("read base blob")
            .expect("base blob exists");
        let (_peer_scratch, mut peer) = self::store();
        seed_main(&mut peer);
        assert_eq!(
            peer.put_binary_blob(&update_bytes).expect("copy base blob"),
            update_sha
        );
        crate::apply_ydoc_envelope(
            &mut peer,
            &crate::ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                op_kind: "ydoc.update".to_owned(),
                payload: base_payload.clone(),
                recorded_at_ms: 11,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("clean peer applies the CRDT base");
        let peer_head: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT latest_moment_id FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='ydoc-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("clean peer projected head");
        assert!(
            peer_head.starts_with("moment-ydoc-apply-"),
            "the clean peer must derive Markdown from the CRDT stream"
        );
    }

    #[test]
    fn secret_backfill_uses_each_moments_retained_ciphertext() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let first = b"historical secret";
        let latest = b"current secret";
        store
            .write_with(&NoFaults, |tx| {
                for (order, id, bytes) in [
                    (1_i64, "moment-first", first.as_slice()),
                    (2_i64, "moment-latest", latest.as_slice()),
                ] {
                    tx.execute(
                        "INSERT INTO secret_moments \
                         (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present,after_iv_base64,after_auth_tag_base64,after_ciphertext_base64,after_byte_length) \
                         VALUES ('ws',?1,?2,'main','.env',?1,'write','api',1,?3,?4,?5,?6)",
                        params![
                            order,
                            id,
                            STANDARD.encode([1_u8; 12]),
                            STANDARD.encode([2_u8; 16]),
                            STANDARD.encode(bytes),
                            bytes.len() as i64,
                        ],
                    )
                    .map_err(SyncError::persist)?;
                }
                tx.execute(
                    "INSERT INTO secret_files \
                     (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                     VALUES ('ws','main','.env',?1,?2,?3,?4,2,'moment-latest')",
                    params![
                        STANDARD.encode([1_u8; 12]),
                        STANDARD.encode([2_u8; 16]),
                        STANDARD.encode(latest),
                        latest.len() as i64,
                    ],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed secret history");

        enroll(&mut store).expect("enroll");

        let shas = local_ops(&store)
            .into_iter()
            .filter(|(kind, _)| kind == "secret.file.put")
            .map(|(_, payload)| {
                payload["ciphertextSha256"]
                    .as_str()
                    .expect("ciphertext sha")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            shas,
            [
                dohc_engine_storage::hex_sha256(first),
                dohc_engine_storage::hex_sha256(latest),
            ]
        );
    }

    #[test]
    fn named_version_is_backfilled_before_its_ydoc_base() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let key = DocKey::new("ws", "named", "forked").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "base");
        dohc_engine_collab::record_local_update_creating_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            &NoFaults,
            21,
        )
        .expect("named ydoc");

        enroll(&mut store).expect("enroll");

        let kinds = local_ops(&store)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect::<Vec<_>>();
        let version = kinds
            .iter()
            .position(|kind| kind == "version.create")
            .expect("version.create");
        let base = kinds
            .iter()
            .position(|kind| kind == "ydoc.update")
            .expect("ydoc.update");
        assert!(
            version < base,
            "the target version must exist before its Y.Doc base"
        );
    }

    #[test]
    fn moment_backfill_follows_durable_moment_order() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store, "main", "first", "moment-z", "first", "capture", 10,
        );
        write_text(
            &mut store, "main", "second", "moment-a", "second", "capture", 10,
        );

        enroll(&mut store).expect("enroll");

        let ids = local_ops(&store)
            .into_iter()
            .filter(|(kind, _)| kind == "moment.append")
            .map(|(_, payload)| payload["momentId"].as_str().expect("moment id").to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["moment-z", "moment-a"]);
    }

    #[test]
    fn delayed_version_backfill_uses_the_frozen_fork_base() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let base_sha = dohc_engine_storage::hex_sha256(b"base");
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        write_text(
            &mut store,
            "named",
            "forked",
            "moment-edit",
            "edited",
            "capture",
            30,
        );

        enroll(&mut store).expect("enroll");

        let fork_sha = local_ops(&store)
            .into_iter()
            .find(|(kind, payload)| kind == "version.create" && payload["versionId"] == "named")
            .expect("named version op")
            .1["forkSnapshots"][0]["blobSha256"]
            .as_str()
            .expect("fork sha")
            .to_owned();
        assert_eq!(
            fork_sha, base_sha,
            "the delayed op must ship the fork-time state"
        );
    }

    #[test]
    fn main_version_is_never_backfilled_as_a_named_fork() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "only",
            "moment-only",
            "only",
            "capture",
            10,
        );

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, _)| kind == "version.create")
                .count(),
            0
        );
    }

    #[test]
    fn already_journaled_named_version_is_not_backfilled_twice() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let record = VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        store
            .write_with(&NoFaults, |tx| journal_version_create_in_tx(tx, &record))
            .expect("journal named version");

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "version.create" && payload["versionId"] == "named"
                })
                .count(),
            1
        );
    }

    #[test]
    fn imported_secret_moments_are_not_echoed_by_enrolment() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO secret_moments \
                     (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present) \
                     VALUES ('ws',1,'secret-sync-peer-0','main','.env',10,'delete','sync',0)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed imported secret moment");

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "secret.file.delete")
        );
    }

    #[test]
    fn enrollment_surfaces_a_declined_ydoc_base() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "oversized",
            "moment-oversized",
            "seed",
            "ydoc",
            10,
        );
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, &"x".repeat(21_000_000));
        let full_state = doc.encode_full_state();
        assert!(
            full_state.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
            "the fixture must cross the base limit"
        );
        let state_sha = store
            .put_binary_blob(&full_state)
            .expect("store full state");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO ydoc_docs \
                     (workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,base_claimed,updated_at_ms) \
                     VALUES ('ws','main','oversized','plaintext','local-only',1,0,0,11)",
                    [],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO ydoc_updates \
                     (workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) \
                     VALUES ('ws','main','oversized',1,?1,11)",
                    [state_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed oversized local lineage");

        let outcome = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES ('ws','local',-1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                backfill_enrolment_window_in_tx(tx, "ws", 1_000)
            })
            .expect("enroll");
        let declines = match outcome {
            dohc_engine_storage::TxnOutcome::Committed(declines) => declines,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };

        assert_eq!(declines.len(), 1, "the caller receives the declined base");
        assert_eq!(declines[0].constraint, "MAX_YDOC_UPDATE_BYTES");
        assert!(declines[0].observed_bytes > declines[0].limit_bytes);
    }
}
