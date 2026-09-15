//! Retained identity of the artifact from which an owner seeded its original base.

use crate::{durable, CollabError, ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_storage::hex_sha256;
use rusqlite::{params, OptionalExtension, Transaction};

/// Captured by the engine when it opens the artifact, never supplied by the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerSeedSource {
    pub moment_id: String,
    pub blob_sha256: String,
}

fn corrupt(reason: &str) -> CollabError {
    CollabError::Corrupt {
        reason: reason.into(),
    }
}

/// Retain the exact source only when this transaction originated a richdoc base.
/// A missing or stale artifact leaves no bridge. It does not prevent local editing.
pub fn retain_owner_base_source_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    path: &str,
    baseline_digest: &str,
    source: &OwnerSeedSource,
) -> Result<bool, CollabError> {
    let marker = durable::read_marker_in(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.content_kind != ContentKind::Richdoc
        || marker.regime != Regime::Replicated
        || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(baseline_digest)
        || marker.path.as_deref() != Some(path)
    {
        return Ok(false);
    }
    let original: Option<String> = tx.query_row(
        "SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
        params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0),
    ).optional().map_err(durable::map_sql)?;
    if original.as_deref() != Some(baseline_digest) {
        return Err(corrupt("original owner base missing"));
    }
    let artifact: Option<(String, i64)> = tx.query_row(
        "SELECT b.text,b.byte_length FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.path=?4 AND m.moment_id=?5 AND m.after_content_kind='text' AND m.after_blob_sha256=?6",
        params![key.workspace_id,key.version_id,key.object_id,path,source.moment_id,source.blob_sha256],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(durable::map_sql)?;
    let Some((text, byte_length)) = artifact else {
        return Ok(false);
    };
    if text.len() as i64 != byte_length || hex_sha256(text.as_bytes()) != source.blob_sha256 {
        return Err(corrupt("owner source artifact integrity"));
    }
    let baseline = durable::binary_blob_for_gate(tx, baseline_digest)?;
    let doc = Ydoc::wire();
    doc.apply(&baseline)?;
    if doc.has_missing_updates() {
        return Ok(false);
    }
    let canonical = match doc.project(ContentKind::Richdoc) {
        Ok(projection) => projection.content,
        Err(CollabError::ProjectionTooLarge { .. } | CollabError::ProjectionTooComplex { .. }) => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let projection = doc
        .preserved_markdown_source(&canonical)
        .unwrap_or(canonical);
    if projection != text {
        return Ok(false);
    }
    let retained: Option<(String,String,String,i64)> = tx.query_row(
        "SELECT path,source_moment_id,source_blob_sha256,source_byte_length FROM ydoc_owner_base_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![key.workspace_id,key.version_id,key.object_id,baseline_digest],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(durable::map_sql)?;
    let expected = (
        path.to_owned(),
        source.moment_id.clone(),
        source.blob_sha256.clone(),
        byte_length,
    );
    if let Some(retained) = retained {
        if retained != expected {
            return Err(corrupt("owner base source identity changed"));
        }
        return Ok(true);
    }
    tx.execute("INSERT INTO ydoc_owner_base_sources (workspace_id,version_id,object_id,lineage_claim_id,path,source_moment_id,source_blob_sha256,source_byte_length) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![key.workspace_id,key.version_id,key.object_id,baseline_digest,path,source.moment_id,source.blob_sha256,byte_length]).map_err(durable::map_sql)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};

    fn write(store: &mut EngineStore, text: &str, moment: &str, now: i64) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "owner.md".into(),
                    text: text.into(),
                    moment_id: moment.into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: now,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }

    #[test]
    fn projection_limits_decline_retention_without_rolling_back_local_work() {
        use yrs::types::xml::XmlIn;
        use yrs::{ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

        for oversized in [false, true] {
            let raw = yrs::Doc::new();
            let body = raw.get_or_insert_xml_fragment(crate::ydoc::ROOT_BODY);
            let text = if oversized {
                "x".repeat(crate::limits::MAX_PROJECTION_BYTES + 1)
            } else {
                "deep".into()
            };
            let mut child: XmlIn =
                XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))]).into();
            if !oversized {
                for _ in 0..=crate::limits::MAX_PROJECTION_DEPTH {
                    child = XmlElementPrelim::new("blockquote", [child]).into();
                }
            }
            body.push_back(&mut raw.transact_mut(), child);
            let baseline = raw
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let doc = Ydoc::wire();
            doc.apply(&baseline).unwrap();
            match doc.project(ContentKind::Richdoc) {
                Err(CollabError::ProjectionTooLarge { .. }) if oversized => {}
                Err(CollabError::ProjectionTooComplex { .. }) if !oversized => {}
                other => panic!("expected projection limit, got {other:?}"),
            }
            let scratch = dohc_test_scratch::ScratchDir::new_named("owner-source-limit").unwrap();
            let mut store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
            VersionedTextStore::new(&mut store)
                .ensure_main_version("workspace", "main", 0, &NoFaults)
                .unwrap();
            write(&mut store, "source", "source", 1);
            let key = DocKey::new("workspace", "main", "object").unwrap();
            durable::claim_base(
                &mut store,
                &key,
                ContentKind::Richdoc,
                &baseline,
                &NoFaults,
                2,
            )
            .unwrap();
            let source = OwnerSeedSource {
                moment_id: "source".into(),
                blob_sha256: hex_sha256(b"source"),
            };
            let outcome = store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET path='owner.md',updated_at_ms=3", [])
                        .unwrap();
                    retain_owner_base_source_in_tx(
                        tx,
                        &key,
                        "owner.md",
                        &hex_sha256(&baseline),
                        &source,
                    )
                })
                .unwrap();
            assert!(matches!(outcome, TxnOutcome::Committed(false)));
            assert_eq!(store.table_row_count("ydoc_owner_base_sources").unwrap(), 0);
            let updated: i64 = store
                .read_with(|conn| {
                    conn.query_row("SELECT updated_at_ms FROM ydoc_docs", [], |row| row.get(0))
                })
                .unwrap();
            assert_eq!(updated, 3);
        }
    }

    #[test]
    fn canonical_source_without_witness_retains_the_base() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("canonical-owner-source").unwrap();
        let mut store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "canonical source")
            .unwrap();
        let text = doc.project(ContentKind::Richdoc).unwrap().content;
        assert!(doc.preserved_markdown_source(&text).is_none());
        let baseline = doc.encode_full_state();
        let digest = hex_sha256(&baseline);
        let key = DocKey::new("workspace", "main", "object").unwrap();
        write(&mut store, &text, "source", 1);
        durable::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &baseline,
            &NoFaults,
            2,
        )
        .unwrap();
        let source = OwnerSeedSource {
            moment_id: "source".into(),
            blob_sha256: hex_sha256(text.as_bytes()),
        };
        assert!(matches!(
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                        .unwrap();
                    retain_owner_base_source_in_tx(tx, &key, "owner.md", &digest, &source)
                })
                .unwrap(),
            TxnOutcome::Committed(true)
        ));
    }

    #[test]
    fn owner_source_keeps_exact_moment_and_rolls_back_with_transaction() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("owner-source").unwrap();
        let mut store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../tests/owner-source/owner-source-seed.json"))
                .unwrap();
        let text = vector["markdown"].as_str().unwrap();
        let baseline: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let digest = hex_sha256(&baseline);
        write(&mut store, text, "original-moment", 1);
        durable::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &baseline,
            &NoFaults,
            2,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                    .unwrap();
                Ok::<_, CollabError>(())
            })
            .unwrap();
        let source = OwnerSeedSource {
            moment_id: "original-moment".into(),
            blob_sha256: hex_sha256(text.as_bytes()),
        };
        let rollback = store.write_with(&NoFaults, |tx| {
            assert!(retain_owner_base_source_in_tx(
                tx, &key, "owner.md", &digest, &source
            )?);
            Err::<(), _>(corrupt("abort after retaining source"))
        });
        assert!(rollback.is_err());
        assert_eq!(store.table_row_count("ydoc_owner_base_sources").unwrap(), 0);
        let missing = OwnerSeedSource {
            moment_id: "missing".into(),
            ..source.clone()
        };
        assert!(matches!(
            store
                .write_with(&NoFaults, |tx| retain_owner_base_source_in_tx(
                    tx, &key, "owner.md", &digest, &missing
                ))
                .unwrap(),
            TxnOutcome::Committed(false)
        ));
        assert!(matches!(
            store
                .write_with(&NoFaults, |tx| retain_owner_base_source_in_tx(
                    tx, &key, "owner.md", &digest, &source
                ))
                .unwrap(),
            TxnOutcome::Committed(true)
        ));
        write(&mut store, "changed", "middle-moment", 3);
        write(&mut store, text, "later-same-digest", 4);
        let later = OwnerSeedSource {
            moment_id: "later-same-digest".into(),
            ..source.clone()
        };
        assert!(store
            .write_with(&NoFaults, |tx| retain_owner_base_source_in_tx(
                tx, &key, "owner.md", &digest, &later
            ))
            .is_err());
        assert!(matches!(
            store
                .write_with(&NoFaults, |tx| retain_owner_base_source_in_tx(
                    tx, &key, "owner.md", &digest, &source
                ))
                .unwrap(),
            TxnOutcome::Committed(true)
        ));
        let retained: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT source_moment_id FROM ydoc_owner_base_sources",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(retained, "original-moment");
    }
}
