//! Backfill rows this workspace locally originated before the live capture
//! path could journal them. Each row class derives its filter from that rule.
//!
//! Named-version payloads always read `fork_base_snapshots`. Named-version
//! creation freezes those rows from the same source as `snapshots` in the same
//! transaction, so the live caller gets identical bytes and delayed backfill
//! keeps the fork-time state.
//!
//! Moment backfill cannot use `metadata_origin` to tell local from imported:
//! `moment_apply.rs` stores the sending peer's wire value verbatim (S2's
//! boundary stamp covers `snapshots`/`fork_base_snapshots`, not `moments`).
//! It excludes an imported moment by exact provenance instead — a matching
//! successfully applied `imported=1` row in `replication_log`, correlated on
//! `momentId` (which the receiver preserves verbatim, unlike secrets). An
//! imported coordinate with a pending refusal did not create the matching
//! domain row, so it is not import provenance. The backfill also excludes
//! `'ydoc'` moments outright, a true local origin whose content the CRDT
//! stream supersedes, and every object with a Y.Doc lineage. Once `ydoc_docs`
//! exists, its base supersedes the moment lane's older representation whether
//! or not the base is claimed.
//!
//! A live append stores its path on `ydoc_docs`, so enrollment can originate
//! the lineage before any settle creates a snapshot. Once a snapshot exists,
//! its path is canonical and can change while the document is closed. The
//! enrollment read therefore prefers the snapshot path and uses the Y.Doc path
//! only for a never-settled lineage. Deferring the live case was unsafe: the
//! local settle path does not retry origination.
//!
//! Secret-version payloads always read `secret_fork_bases`, including the
//! source tip's frozen last-edit timestamp. Receivers store `updatedAtMs` in
//! `secret_files`, so exact replay preserves both ciphertext and row metadata.

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{SecretMomentRecord, SecretOp, VersionKind, VersionRecord};
use rusqlite::{Row, Transaction};

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
    let rows: Vec<(String, String, Option<String>)> = collect_rows(
        tx,
        "SELECT d.version_id, d.object_id, COALESCE(s.path,d.path) \
         FROM ydoc_docs d LEFT JOIN snapshots s \
           ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id \
          AND s.object_id=d.object_id \
         WHERE d.workspace_id=?1 AND d.base_claimed=0 \
         ORDER BY d.version_id, d.object_id",
        workspace_id,
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut sharing_declined = Vec::new();
    for (version_id, object_id, path) in rows {
        let path = path.ok_or_else(|| {
            SyncError::corrupt(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unclaimed Y.Doc path is NULL at {workspace_id}/{version_id}/{object_id}"),
            ))
        })?;
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
    // `metadata_origin` alone cannot tell a locally-authored moment from an
    // imported one: `moment_apply.rs`'s `INSERT INTO moments` stores the
    // WIRE payload's `metadata.origin` verbatim (the sending peer's own
    // value — "api", "capture", "local-file", whatever that peer used), not
    // a boundary stamp. Only `snapshots`/`fork_base_snapshots` get S2's
    // "sync" stamp. The reliable discriminator is real import provenance:
    // `moment_apply.rs` preserves the sender's `moment_id` verbatim (unlike
    // secrets, which re-mint theirs), and every applied envelope lands a
    // matching `imported=1` row in `replication_log` in the same transaction.
    // A refused coordinate is logged and ACKed too, but its pending refusal
    // still exists while first-position backfill runs. Exclude only a matching
    // coordinate with no refusal. `'ydoc'` is excluded separately: it is a
    // true local origin (Y.Doc settle-projection), never imported, but its
    // content is superseded by the CRDT stream once a lineage exists.
    let moment_ids: Vec<String> = collect_rows(
        tx,
        "SELECT m.moment_id FROM moments m \
         WHERE m.workspace_id=?1 AND m.metadata_origin != 'ydoc' \
           AND NOT EXISTS (SELECT 1 FROM replication_log r \
              WHERE r.workspace_id=?1 AND r.imported=1 AND r.op_kind='moment.append' \
                AND json_extract(r.payload_json,'$.momentId')=m.moment_id \
                AND NOT EXISTS (SELECT 1 FROM replication_pending_refusals p \
                  WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
                    AND p.origin_seq=r.origin_seq)) \
           AND NOT EXISTS (SELECT 1 FROM ydoc_docs d \
             WHERE d.workspace_id=m.workspace_id AND d.version_id=m.version_id \
               AND d.object_id=m.object_id) \
         ORDER BY m.moment_order",
        workspace_id,
        |row| row.get(0),
    )?;
    for moment_id in moment_ids {
        journal_moment_append_in_tx(tx, workspace_id, &moment_id)?;
    }
    Ok(())
}

fn backfill_versions(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    type VersionRow = (String, String, String, i64, Option<String>, Option<String>);
    // The JSON lookup scans the workspace log once for each named version.
    // Enrollment runs once per workspace, so this bounded startup cost does
    // not justify another durable index or an in-memory shadow of the log.
    let raw_records: Vec<VersionRow> = collect_rows(
        tx,
        "SELECT v.version_id, v.kind, v.name, v.created_at_ms, \
                    v.fork_version_id, v.fork_moment_id \
             FROM versions v \
             WHERE v.workspace_id=?1 AND v.kind='named' \
                AND NOT EXISTS (SELECT 1 FROM replication_log r \
                  WHERE r.workspace_id=?1 AND r.op_kind='version.create' \
                    AND json_extract(r.payload_json,'$.versionId')=v.version_id \
                    AND (r.imported=0 OR NOT EXISTS ( \
                      SELECT 1 FROM replication_pending_refusals p \
                      WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
                        AND p.origin_seq=r.origin_seq))) \
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
    let mut pending = records;
    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let next = pending.iter().position(|record| {
            record.fork_version_id.as_ref().is_none_or(|parent_id| {
                !pending
                    .iter()
                    .any(|candidate| candidate.version_id == *parent_id)
            })
        });
        let Some(next) = next else {
            return Err(SyncError::corrupt(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("named version fork graph contains a cycle in workspace {workspace_id}"),
            )));
        };
        ordered.push(pending.remove(next));
    }
    for record in ordered {
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
         FROM secret_moments sm \
         WHERE sm.workspace_id=?1 AND sm.source_origin_id IS NULL \
         ORDER BY sm.moment_order",
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
    use dohc_engine_crypto::{SECRET_KEY_BYTES, SecretDataKey};
    use dohc_engine_domain::{
        CreateNamedVersion, RenameTextFile, SecretDelete, SecretDiskIntent, SecretFileStore,
        SecretWrite, VersionedTextStore, WriteText,
    };
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

    fn record_unsettled_ydoc(
        store: &mut EngineStore,
        key: &DocKey,
        update: &[u8],
        path: Option<&str>,
        request_id: Option<&str>,
    ) -> dohc_engine_collab::AppendOutcome {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO file_objects
                     (workspace_id, object_id, created_at_ms) VALUES ('ws', ?1, 2)",
                    [&key.object_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("file object");
        match dohc_engine_collab::record_local_update_creating_marker_guarded(
            store,
            key,
            path,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            false,
            true,
            request_id,
            &NoFaults,
            3,
            |_, _| Ok(()),
        )
        .expect("record unsettled Y.Doc")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
    }

    fn ydoc_path(store: &EngineStore, object_id: &str) -> Option<String> {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT path FROM ydoc_docs
                     WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [object_id],
                    |row| row.get(0),
                )
            })
            .expect("Y.Doc path")
    }

    fn secret_key() -> SecretDataKey {
        SecretDataKey::from_bytes(&[7_u8; SECRET_KEY_BYTES]).expect("test secret key")
    }

    fn write_secret(
        store: &mut EngineStore,
        key: &SecretDataKey,
        version_id: &str,
        moment_id: &str,
        text: &str,
        now_ms: i64,
    ) {
        SecretFileStore::new(store, key)
            .write_secret_file(
                &SecretWrite {
                    workspace_id: "ws".to_owned(),
                    version_id: version_id.to_owned(),
                    path: ".env".to_owned(),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                &NoFaults,
            )
            .expect("write secret");
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
        // The exclusion reads real import provenance (`replication_log`), not
        // `metadata_origin` — `moment_apply.rs` stores the sender's wire value
        // verbatim, so a domain write alone does not simulate an import. Seed
        // the matching imported row a real pull would have landed.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','peer',0,'moment.append',?1,10,1)",
                    [serde_json::json!({"momentId": "moment-imported"}).to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed imported provenance");

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "moment.append"),
            "an imported moment must not be journaled under the receiver's origin"
        );
    }

    #[test]
    fn refused_import_does_not_hide_a_local_moment_with_the_same_id() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "local",
            "moment-collision",
            "local",
            "capture",
            10,
        );
        let refused = crate::ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: "moment.append".to_owned(),
            payload: serde_json::json!({"momentId": "moment-collision"}),
            recorded_at_ms: 10,
        };
        assert!(matches!(
            crate::apply_moment_envelope(&mut store, &refused, &NoFaults),
            Ok(crate::ApplyOutcome::Refused(_))
        ));

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "moment.append" && payload["momentId"] == "moment-collision"
                })
                .count(),
            1,
            "a refused import is not successful import provenance"
        );
    }

    #[test]
    fn refused_import_does_not_hide_a_local_version_with_the_same_id() {
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
                    new_version_id: "named-collision".to_owned(),
                    name: "Named collision".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let refused = crate::ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: "version.create".to_owned(),
            payload: serde_json::json!({"versionId": "named-collision"}),
            recorded_at_ms: 20,
        };
        assert!(matches!(
            crate::apply_version_envelope(&mut store, &refused, &NoFaults),
            Ok(crate::ApplyOutcome::Refused(_))
        ));

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "version.create" && payload["versionId"] == "named-collision"
                })
                .count(),
            1,
            "a refused import is not successful import provenance"
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
            Some("ydoc-object.md"),
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
    fn closed_rename_backfills_the_ydoc_base_at_the_current_path() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "renamed-object",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let key = DocKey::new("ws", "main", "renamed-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "base");
        record_unsettled_ydoc(&mut store, &key, &update, Some("renamed-object.md"), None);
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    from_path: "renamed-object.md".to_owned(),
                    to_path: "current-name.md".to_owned(),
                    moment_id: "moment-rename".to_owned(),
                    request_id: None,
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 11,
                },
                &NoFaults,
            )
            .expect("rename closed document");
        assert_eq!(
            ydoc_path(&store, "renamed-object").as_deref(),
            Some("renamed-object.md"),
            "the Y.Doc marker intentionally retains the last live-session path"
        );

        enroll(&mut store).expect("enroll");

        let payload = local_ops(&store)
            .into_iter()
            .find_map(|(kind, payload)| {
                (kind == "ydoc.update" && payload["objectId"] == "renamed-object")
                    .then_some(payload)
            })
            .expect("backfilled Y.Doc base");
        assert_eq!(
            payload["path"], "current-name.md",
            "enrollment must derive the current closed-document path from the snapshot"
        );
    }

    #[test]
    #[ignore = "known cross-shard first-pull Y.Doc origination race; item 5 is repro-only"]
    fn first_remote_base_claim_prevents_local_ydoc_origination() {
        let (_source_scratch, mut source) = store();
        seed_main(&mut source);
        let key = DocKey::new("ws", "main", "same-coordinate").expect("key");
        let source_doc = Ydoc::wire();
        let source_update = source_doc.plaintext_insert(0, "remote edit");
        record_unsettled_ydoc(
            &mut source,
            &key,
            &source_update,
            Some("same-coordinate.md"),
            None,
        );
        enroll(&mut source).expect("source enrolls");
        let source_ops = local_ops(&source);
        let remote_payload = source_ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload.clone()))
            .expect("remote base payload");
        let remote_sha = remote_payload["updateBlobSha256"]
            .as_str()
            .expect("remote base sha")
            .to_owned();
        let remote_bytes = source
            .get_binary_blob(&remote_sha)
            .expect("read remote base")
            .expect("remote base exists");

        let (_local_scratch, mut local) = store();
        seed_main(&mut local);
        let local_doc = Ydoc::wire();
        let local_update = local_doc.plaintext_insert(0, "local edit");
        record_unsettled_ydoc(
            &mut local,
            &key,
            &local_update,
            Some("same-coordinate.md"),
            None,
        );
        assert_eq!(
            local
                .put_binary_blob(&remote_bytes)
                .expect("copy remote base"),
            remote_sha
        );
        crate::apply_ydoc_envelope(
            &mut local,
            &crate::ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                op_kind: "ydoc.update".to_owned(),
                payload: remote_payload,
                recorded_at_ms: 4,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("first pull applies remote base");

        let (base_claimed, base_sha, local_updates): (i64, String, i64) = local
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT base_claimed FROM ydoc_docs
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT snapshot_blob_sha256 FROM ydoc_snapshots
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate' AND up_to_seq=0",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_updates
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("local lineage after remote claim");
        assert_eq!(
            base_claimed, 1,
            "the remote base consumed the unclaimed slot"
        );
        assert_eq!(base_sha, remote_sha, "the claimed base is the remote base");
        assert_eq!(
            local_updates, 1,
            "the independent local durable update remains stranded behind the remote base"
        );

        enroll(&mut local).expect("first-position backfill");
        let local_ydoc_ops = local_ops(&local)
            .into_iter()
            .filter(|(kind, _)| kind == "ydoc.update")
            .count();
        assert_eq!(
            local_ydoc_ops, 1,
            "first-position enrolment must originate the pre-existing local Y.Doc history"
        );
    }

    #[test]
    fn request_retry_repairs_a_legacy_unsettled_ydoc_path() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-request").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        assert!(!record_unsettled_ydoc(&mut store, &key, &update, None, Some("request-1")).deduped);
        assert_eq!(ydoc_path(&store, "legacy-request"), None);

        let retry = match dohc_engine_collab::record_local_update_creating_marker_guarded(
            &mut store,
            &key,
            Some("legacy-request.md"),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            false,
            true,
            Some("request-1"),
            &NoFaults,
            4,
            |_, _| Ok(()),
        )
        .expect("retry")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert!(retry.deduped);
        assert_eq!(
            ydoc_path(&store, "legacy-request").as_deref(),
            Some("legacy-request.md"),
            "a request-id retry must repair the path before it returns"
        );
    }

    #[test]
    fn content_retry_repairs_a_legacy_unsettled_ydoc_path() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-content").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        assert!(!record_unsettled_ydoc(&mut store, &key, &update, None, None).deduped);
        assert_eq!(ydoc_path(&store, "legacy-content"), None);

        let retry = match dohc_engine_collab::record_local_update_creating_marker_guarded(
            &mut store,
            &key,
            Some("legacy-content.md"),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            false,
            true,
            None,
            &NoFaults,
            4,
            |_, _| Ok(()),
        )
        .expect("retry")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert!(retry.deduped);
        assert_eq!(
            ydoc_path(&store, "legacy-content").as_deref(),
            Some("legacy-content.md"),
            "a content-hash retry must repair the path before it returns"
        );
    }

    #[test]
    fn enrolment_rejects_an_unclaimed_ydoc_without_a_path() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-orphan").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        record_unsettled_ydoc(&mut store, &key, &update, None, None);

        let error = enroll(&mut store).expect_err("a missing Y.Doc path must fail enrolment");
        let message = format!("{error:?}");
        assert!(message.contains("ws/main/legacy-orphan"), "{message}");
        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "ydoc.update"),
            "the corrupt lineage must not be silently dropped or journaled"
        );
    }

    #[test]
    fn capture_history_is_superseded_when_the_same_object_gains_a_ydoc_lineage() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "live-object",
            "moment-before-live",
            "captured before live editing",
            "capture",
            10,
        );
        let key = DocKey::new("ws", "main", "live-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "edited in the live session");
        dohc_engine_collab::record_local_update_creating_marker(
            &mut store,
            &key,
            Some("live-object.md"),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            &NoFaults,
            11,
        )
        .expect("record live edit");
        write_text(
            &mut store,
            "main",
            "live-object",
            "moment-live-settle",
            "edited in the live session",
            "ydoc",
            12,
        );

        enroll(&mut store).expect("enroll after settle");

        let ops = local_ops(&store);
        let (_peer_scratch, mut peer) = self::store();
        seed_main(&mut peer);
        for (origin_seq, (kind, payload)) in ops.iter().enumerate() {
            if kind == "ydoc.update" {
                let sha = payload["updateBlobSha256"]
                    .as_str()
                    .expect("Y.Doc blob sha");
                let bytes = store
                    .get_binary_blob(sha)
                    .expect("read Y.Doc blob")
                    .expect("Y.Doc blob exists");
                assert_eq!(peer.put_binary_blob(&bytes).expect("copy Y.Doc blob"), sha);
            } else if kind == "moment.append" {
                let sha = payload["payloadAfterBlobSha256"]
                    .as_str()
                    .expect("moment blob sha");
                let (byte_length, text): (i64, String) = store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                            [sha],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                    })
                    .expect("read moment blob");
                peer.write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                        params![sha, byte_length, text],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("copy moment blob");
            }
            crate::apply_replication_envelope(
                &mut peer,
                &crate::ReplicationEnvelope {
                    workspace_id: "ws".to_owned(),
                    origin_id: "source".to_owned(),
                    origin_seq: origin_seq as i64,
                    op_kind: kind.clone(),
                    payload: payload.clone(),
                    recorded_at_ms: 20 + origin_seq as i64,
                },
                &NoFaults,
                &crate::NoLiveLeases,
            )
            .expect("clean peer replays backfilled op");
        }
        let peer_text: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.object_id='live-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("clean peer head");
        assert_eq!(peer_text, "edited in the live session");
        assert_eq!(
            ops.iter().filter(|(kind, _)| kind == "ydoc.update").count(),
            1,
            "the live lineage must backfill exactly one canonical representation"
        );
        assert_eq!(
            ops.iter()
                .filter(|(kind, _)| kind == "moment.append")
                .count(),
            0,
            "the older capture history must not compete with its Y.Doc lineage"
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
    fn secret_write_then_delete_backfills_without_delete_ciphertext() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(&mut store, &key, "main", "moment-secret-put", "token", 10);
        SecretFileStore::new(&mut store, &key)
            .delete_secret_file(
                &SecretDelete {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: ".env".to_owned(),
                    moment_id: "moment-secret-delete".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 11,
                },
                &NoFaults,
            )
            .expect("delete secret")
            .expect("delete moment");

        enroll(&mut store).expect("enroll");

        let kinds = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, _)| kind.starts_with("secret.file.").then_some(kind))
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["secret.file.put", "secret.file.delete"]);
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
            Some("forked.md"),
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
    fn forked_ydoc_base_fast_forwards_its_shipped_ancestor() {
        let (_source_scratch, mut source) = store();
        seed_main(&mut source);
        write_text(
            &mut source,
            "main",
            "forked-history",
            "moment-base",
            "base",
            "ydoc",
            10,
        );
        VersionedTextStore::new(&mut source)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named-history".to_owned(),
                    name: "Named history".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let key = DocKey::new("ws", "named-history", "forked-history").expect("key");
        let doc = Ydoc::wire();
        let base_update = doc.plaintext_insert(0, "base");
        dohc_engine_collab::record_local_update_creating_marker(
            &mut source,
            &key,
            Some("forked-history.md"),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &base_update,
            None,
            &NoFaults,
            21,
        )
        .expect("named Y.Doc base state");
        let post_fork_update = doc.plaintext_insert(4, " plus edit");
        dohc_engine_collab::record_local_update(
            &mut source,
            &key,
            &post_fork_update,
            &NoFaults,
            22,
        )
        .expect("post-fork Y.Doc edit");
        enroll(&mut source).expect("source enrolls");

        let ops = local_ops(&source);
        let version_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "version.create").then_some(payload.clone()))
            .expect("version.create payload");
        assert_eq!(
            version_payload["forkSnapshots"][0]["metadata"]["origin"], "ydoc",
            "the shipped fork snapshot must identify its Y.Doc ancestry"
        );
        let base_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload.clone()))
            .expect("Y.Doc base payload");
        let base_sha = base_payload["updateBlobSha256"].as_str().expect("base sha");
        let base_bytes = source
            .get_binary_blob(base_sha)
            .expect("read base")
            .expect("base exists");

        let (_peer_scratch, mut peer) = store();
        seed_main(&mut peer);
        let fork_sha = dohc_engine_storage::hex_sha256(b"base");
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, 4, 'base')",
                [&fork_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("copy fork snapshot blob");
        assert_eq!(
            peer.put_binary_blob(&base_bytes).expect("copy base"),
            base_sha
        );
        crate::apply_version_envelope(
            &mut peer,
            &crate::ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                op_kind: "version.create".to_owned(),
                payload: version_payload,
                recorded_at_ms: 20,
            },
            &NoFaults,
        )
        .expect("peer applies version.create");
        let outcome = crate::apply_ydoc_envelope(
            &mut peer,
            &crate::ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 1,
                op_kind: "ydoc.update".to_owned(),
                payload: base_payload,
                recorded_at_ms: 22,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("peer applies Y.Doc base");
        assert_eq!(
            outcome,
            crate::ApplyOutcome::Applied(crate::YdocApplyResult {
                deferred: false,
                reason: None,
                conflicts_opened: 0,
                sharing_declined: None,
            }),
            "the Y.Doc base must fast-forward its shipped fork ancestor"
        );
    }

    #[test]
    fn named_version_parent_is_backfilled_before_same_time_child() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "zzz-parent".to_owned(),
                    name: "Parent".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("parent version");
        versions
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "zzz-parent".to_owned(),
                    new_version_id: "aaa-child".to_owned(),
                    name: "Child".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("child version");

        enroll(&mut store).expect("enroll");

        let version_ids = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, payload)| {
                (kind == "version.create").then(|| {
                    payload["versionId"]
                        .as_str()
                        .expect("version id")
                        .to_owned()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            version_ids,
            ["zzz-parent", "aaa-child"],
            "a fork parent must be journaled before its child"
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
    fn delayed_secret_fork_backfill_uses_the_frozen_fork_base() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(&mut store, &key, "main", "moment-secret-base", "base", 10);
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
        let frozen_ciphertext: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT ciphertext_base64 FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='named' AND path='.env'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("frozen secret base");
        let frozen_sha = dohc_engine_storage::hex_sha256(
            &STANDARD
                .decode(frozen_ciphertext)
                .expect("frozen ciphertext is base64"),
        );
        write_secret(
            &mut store,
            &key,
            "named",
            "moment-secret-edit",
            "edited",
            30,
        );

        enroll(&mut store).expect("enroll");

        let fork_payload = local_ops(&store)
            .into_iter()
            .find(|(kind, payload)| {
                kind == "secret.version.fork" && payload["toVersionId"] == "named"
            })
            .expect("secret fork op")
            .1;
        let fork_sha = fork_payload["rows"][0]["ciphertextSha256"]
            .as_str()
            .expect("fork ciphertext sha")
            .to_owned();
        assert_eq!(
            fork_sha, frozen_sha,
            "the delayed secret fork must ship the fork-time ciphertext"
        );
        assert_eq!(fork_payload["rows"][0]["updatedAtMs"], 10);
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
        let imported = crate::ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: "secret.file.delete".to_owned(),
            payload: serde_json::json!({
                "versionId": "main",
                "path": ".env",
                "metadata": {"origin": "sync"}
            }),
            recorded_at_ms: 10,
        };
        assert!(matches!(
            crate::apply_secret_envelope(&mut store, &imported, &NoFaults),
            Ok(crate::ApplyOutcome::Applied(()))
        ));
        let source: (Option<String>, Option<i64>) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT source_origin_id,source_origin_seq FROM secret_moments \
                     WHERE workspace_id='ws' AND path='.env'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("imported secret provenance");
        assert_eq!(source, (Some("peer".to_owned()), Some(0)));

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "secret.file.delete")
        );
    }

    #[test]
    fn imported_secret_coordinates_cannot_hide_an_unrelated_local_moment() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(
            &mut store,
            &key,
            "main",
            "local-secret-collision",
            "genuinely local content",
            10,
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','unrelated-peer',91,'secret.file.put',?1,10,1)",
                    [serde_json::json!({
                        "versionId": "main",
                        "path": ".env",
                        "metadata": {"origin": "sync"},
                        "ciphertextSha256": "unrelated-imported-content",
                    })
                    .to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed colliding imported coordinate");

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "secret.file.put" && payload["versionId"] == "main"
                })
                .count(),
            1,
            "an imported timestamp and payload correlation must not hide a local secret moment"
        );
    }

    #[test]
    fn caller_chosen_secret_sync_prefix_does_not_hide_a_local_secret_write() {
        let (_scratch, mut store) = store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(
            &mut store,
            &key,
            "main",
            "secret-sync-caller-chosen",
            "local secret",
            10,
        );

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, _)| kind == "secret.file.put")
                .count(),
            1,
            "caller-controlled text must not forge imported provenance"
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
                     (workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,base_claimed,updated_at_ms,path) \
                     VALUES ('ws','main','oversized','plaintext','local-only',1,0,0,11,'oversized.md')",
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
