use super::*;
use dohc_engine_collab::{
    ContentKind, DocKey, LeaseRegistry, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_domain::{
    ChangeActorKind, ChangeAttribution, RenameTextFile, ResolveConflictKind, ResolveTextConflict,
    WriteText,
};

const SCHEMA_PATH: &str = "missions/collection.yaml";
const SCHEMA: &str = "fields: {}\n";
const RECORD: &str = "apollo";
const RECORD_PATH: &str = "missions/apollo.md";
const MOVED_PATH: &str = "missions/apollo-11.md";
const PLANNED: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nStatus: Planned\n---\n# Apollo\n";
const FLOWN: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nStatus: Flown\n---\n# Apollo\n";
const NOTES: &str = "Crew notes.";
const LOG: &str = "Splashdown logged.";
const GEMINI_PATH: &str = "missions/gemini.md";
const GEMINI: &str = "# Gemini\n";
// A note whose rich document cannot reproduce its source, and the canonical
// Markdown that document projects.
const LOSSY: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n- \n\n  - b\n - c";
const LOSSY_CANONICAL: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n- \n\n- b\n- c";

fn sha(text: &str) -> String {
    dohc_engine_storage::hex_sha256(text.as_bytes())
}

fn key() -> DocKey {
    DocKey::new("ws", "main", RECORD).expect("record key")
}

fn richdoc(markdown: &str) -> Ydoc {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
        .expect("rich document");
    doc
}

fn projected(doc: &Ydoc) -> String {
    doc.project(ContentKind::Richdoc)
        .expect("project the record")
        .content
}

/// `markdown` as a rich document writes it, so a resolution can fold it.
fn md(markdown: &str) -> String {
    projected(&richdoc(markdown))
}

fn device(origin: &str) -> (ScratchDir, EngineStore) {
    let (scratch, _path, mut a) = open_store();
    VersionedTextStore::new(&mut a)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .expect("main version");
    adopt_join_identity(&mut a, "ws", origin, "epoch-1", "stream-1", 1, &NoFaults)
        .expect("device identity");
    a.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO sync_relay_push_state VALUES ('ws',?1,-1)",
            [origin],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })
    .expect("device push state");
    (scratch, a)
}

fn a_journals(
    a: &mut EngineStore,
    moment: &str,
    change: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), SyncError>,
) -> ReplicationEnvelope {
    a.write_with(&NoFaults, |tx| {
        change(tx)?;
        journal_moment_append_in_tx(tx, "ws", moment)
    })
    .expect("A changes the file");
    a.read_with(|conn| {
        conn.query_row(
            "SELECT origin_id,origin_seq,payload_json,recorded_at_ms FROM replication_log \
             WHERE workspace_id='ws' AND imported=0 AND op_kind='moment.append' \
               AND json_extract(payload_json,'$.momentId')=?1",
            [moment],
            |row| {
                Ok(ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: "ws".into(),
                    origin_id: row.get(0)?,
                    origin_seq: row.get(1)?,
                    op_kind: "moment.append".into(),
                    payload: serde_json::from_str(&row.get::<_, String>(2)?)
                        .expect("journaled payload"),
                    recorded_at_ms: row.get(3)?,
                    relay_seq: None,
                })
            },
        )
    })
    .expect("A journals the moment")
}

fn a_saves(
    a: &mut EngineStore,
    object: &str,
    path: &str,
    text: &str,
    moment: &str,
    now_ms: i64,
) -> ReplicationEnvelope {
    let input = WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: object.into(),
        moment_id: moment.into(),
        path: path.into(),
        text: text.into(),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    };
    a_journals(a, moment, |tx| {
        dohc_engine_domain::write_text_in_tx(tx, &input).map_err(SyncError::corrupt)?;
        Ok(())
    })
}

fn a_creates_apollo(a: &mut EngineStore, apollo: &str) -> Vec<ReplicationEnvelope> {
    vec![
        a_saves(
            a,
            "missions-schema",
            SCHEMA_PATH,
            SCHEMA,
            "schema-saved",
            10,
        ),
        a_saves(a, RECORD, RECORD_PATH, apollo, "apollo-planned", 20),
    ]
}

fn pull(b: &mut EngineStore, from: i64, ops: &[ReplicationEnvelope], texts: &[&str]) {
    let next = from + ops.len() as i64;
    let mut relay = PagedRelay::new([(
        from,
        PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: ops.to_vec(),
            next_cursor: next,
            has_more: false,
        },
    )]);
    for text in texts {
        relay.blobs.insert(sha(text), text.as_bytes().to_vec());
    }
    let client = RelaySyncClient::new(relay);
    let leases = LeaseRegistry::new();
    let result = client
        .pull_chat_workspace(
            b,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &leases,
            2_100,
        )
        .expect("pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = result
    else {
        panic!("{result:?}");
    };
    client
        .commit_pull_cursor(b, "ws", &cursor, &NoFaults, &leases, 2_100)
        .expect("commit the pull cursor");
}

fn device_b(
    created: &[ReplicationEnvelope],
    apollo: &str,
) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut b) = open_store();
    seed_identity(&mut b);
    VersionedTextStore::new(&mut b)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    pull(&mut b, 0, created, &[SCHEMA, apollo]);
    b.write_with(&NoFaults, |tx| {
        dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")
    })
    .expect("bind the record");
    (scratch, path, b)
}

/// B opens Apollo: `doc` seeds it from `file`, then each of `typing` is a
/// paragraph a named typist adds, never settled.
fn b_opens(b: &mut EngineStore, doc: &Ydoc, file: &str, typing: &[&str]) {
    let key = key();
    let mut cache = WriterDocCache::new();
    let marker = MarkerCreation {
        path: Some(RECORD_PATH),
        content_kind: ContentKind::Richdoc,
        regime: Regime::LocalOnly,
    };
    let file_sha = sha(file);
    dohc_engine_collab::record_local_update(
        b,
        &mut cache,
        &key,
        &doc.encode_full_state(),
        LocalAppend {
            marker: Some(marker),
            is_seed: true,
            seed_source_sha256: Some(&file_sha),
            ..Default::default()
        },
        &NoFaults,
        2_000,
        |_tx, _outcome, _sha| Ok(()),
    )
    .expect("seed the record from its file");
    b_types(b, &mut cache, doc, typing, 2_001);
}

fn b_types(b: &mut EngineStore, cache: &mut WriterDocCache, doc: &Ydoc, typing: &[&str], at: i64) {
    let attribution = ChangeAttribution {
        actor_kind: ChangeActorKind::Human,
        on_behalf_of: None,
        depth: 0,
        run: None,
        agent_run_id: None,
    };
    for (index, paragraph) in typing.iter().enumerate() {
        dohc_engine_collab::record_local_update(
            b,
            cache,
            &key(),
            &doc.richdoc_append_paragraph(paragraph),
            LocalAppend {
                marker: Some(MarkerCreation {
                    path: Some(RECORD_PATH),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                actor_origin_id: Some("typist"),
                attribution: Some(&attribution),
                ..Default::default()
            },
            &NoFaults,
            at + index as i64,
            |_tx, _outcome, _sha| Ok(()),
        )
        .expect("type into the record");
    }
}

fn device_c_base(b: &mut EngineStore, doc: &Ydoc) -> String {
    let sha = b
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let mut base = envelope(
        "device-c",
        0,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":RECORD, "path":RECORD_PATH,
            "contentKind":"richdoc", "updateBlobSha256":sha, "lineageClaimId":sha,
            "isBaseState":true,
        }),
    );
    base.relay_seq = Some(10);
    assert!(matches!(
        apply_ydoc_envelope(
            b,
            &mut WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases
        )
        .expect("apply the base")
        .primary,
        ApplyDisposition::Applied(_)
    ));
    sha
}

fn hydrate(b: &mut EngineStore, texts: &[&str]) {
    b.write_with(&NoFaults, |tx| {
        for text in texts {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha(text), text.len() as i64, text],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })
    .expect("hydrate text blobs");
}

fn deliver(
    b: &mut EngineStore,
    op: &ReplicationEnvelope,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    apply_replication_envelope(b, &mut WriterDocCache::new(), op, &NoFaults, leases)
}

fn assert_conflicts_opened(outcome: ApplyOutcome<RoutedApply>, opened: i64) {
    assert!(
        matches!(
            outcome.primary,
            ApplyDisposition::Applied(ref applied) if applied.conflicts_opened == opened
        ),
        "{outcome:?}"
    );
    assert!(outcome.refusals.is_empty());
}

fn head_text(b: &EngineStore, object: &str) -> Option<String> {
    b.read_with(|conn| {
        conn.query_row(
            "SELECT bl.text FROM snapshots s JOIN blobs bl ON bl.sha256=s.blob_sha256 \
             WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id=?1",
            [object],
            |row| row.get(0),
        )
        .optional()
    })
    .expect("head text")
}
fn indexed_status(b: &EngineStore) -> Option<serde_json::Value> {
    b.read_with(|conn| {
        dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
            conn, "ws", "main", RECORD,
        )
    })
    .expect("indexed record")
    .and_then(|fields| fields.get("Status").cloned())
}

fn open_conflicts(b: &EngineStore) -> Vec<(String, String)> {
    b.read_with(|conn| {
        conn.prepare(
            "SELECT current_blob_sha256,incoming_blob_sha256 FROM conflicts \
             WHERE workspace_id='ws' AND status='open' ORDER BY created_at_ms,conflict_id",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
    })
    .expect("open conflicts")
}

fn count(b: &EngineStore, sql: &str) -> i64 {
    b.read_with(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .expect(sql)
}

fn history_holds(b: &EngineStore, text: &str) -> i64 {
    b.read_with(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND object_id=?1 \
               AND after_blob_sha256=?2",
            params![RECORD, sha(text)],
            |row| row.get(0),
        )
    })
    .expect("History moments")
}

/// How many other files hold `text`, as a recovery copy of the record does.
fn recovered(b: &EngineStore, text: &str) -> i64 {
    b.read_with(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id<>?1 \
               AND blob_sha256=?2",
            params![RECORD, sha(text)],
            |row| row.get(0),
        )
    })
    .expect("recovery copies")
}

fn side_records(b: &EngineStore) -> i64 {
    count(
        b,
        "SELECT COUNT(*) FROM engine_requests WHERE kind='sync-ydoc-conflict-side'",
    )
}

fn lineage_rows(b: &EngineStore) -> i64 {
    count(
        b,
        "SELECT (SELECT COUNT(*) FROM ydoc_docs WHERE object_id='apollo') \
         + (SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo') \
         + (SELECT COUNT(*) FROM ydoc_snapshots WHERE object_id='apollo')",
    )
}

fn lineage_text(b: &EngineStore) -> String {
    projected(
        &dohc_engine_collab::load_persisted(b, &key())
            .expect("load the lineage")
            .expect("the lineage remains")
            .doc,
    )
}

fn resolve(b: &mut EngineStore, resolution: ResolveConflictKind) {
    let conflict_id: String = b
        .read_with(|conn| {
            conn.query_row(
                "SELECT conflict_id FROM conflicts WHERE status='open'",
                [],
                |row| row.get(0),
            )
        })
        .expect("open conflict");
    let input = ResolveTextConflict {
        workspace_id: "ws".into(),
        conflict_id,
        resolution,
        object_id: "apollo-resolution-object".into(),
        write_moment_id: "apollo-resolved".into(),
        delete_moment_id: "apollo-resolved-delete".into(),
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 2_500,
        request_id: None,
        conflict_answer_budget_bytes: usize::MAX,
    };
    let map_error = |error| {
        dohc_engine_domain::DomainError::Storage(dohc_engine_storage::StorageError::corrupt_public(
            error,
        ))
    };
    let result = VersionedTextStore::new(b)
        .resolve_text_conflict_with(
            &input,
            &NoFaults,
            |tx, conflict, _| {
                crate::prepare_local_conflict_resolve_v1_in_tx(tx, &input, conflict)
                    .map_err(map_error)
            },
            |tx, result, prepared| {
                crate::commit_local_conflict_resolve_v1_in_tx(tx, &prepared, result)
                    .map_err(map_error)
            },
        )
        .expect("resolve the record's conflict");
    assert_eq!(
        result.conflict.status,
        dohc_engine_domain::ConflictStatus::Resolved
    );
}

#[test]
fn record_file_edit_retires_a_pristine_unclaimed_seed_and_reseeds() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    assert_eq!(indexed_status(&b), Some(json!("Planned")));
    b_opens(&mut b, &richdoc(&planned), &planned, &[]);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    pull(&mut b, 2, std::slice::from_ref(&flown_op), &[&flown]);

    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        flown_op.origin_seq
    );
    assert_eq!(head_text(&b, RECORD), Some(flown.clone()));
    assert_eq!(indexed_status(&b), Some(json!("Flown")));
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"
        ),
        1,
        "History holds A's edit"
    );
    assert_eq!(lineage_rows(&b), 0, "the untouched seed retires");
    assert!(open_conflicts(&b).is_empty());

    let flown_sha = sha(&flown);
    dohc_engine_collab::record_local_update(
        &mut b,
        &mut WriterDocCache::new(),
        &key(),
        &richdoc(&flown).encode_full_state(),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some(RECORD_PATH),
                content_kind: ContentKind::Richdoc,
                regime: Regime::LocalOnly,
            }),
            require_empty_lineage: true,
            is_seed: true,
            seed_source_sha256: Some(&flown_sha),
            ..Default::default()
        },
        &NoFaults,
        3_000,
        |_tx, _outcome, _sha| Ok(()),
    )
    .expect("reseed from the new file");

    // A reverts the file to bytes the old seed once projected. Only the
    // current seed's source decides; it retires again.
    let reverted = a_saves(&mut a, RECORD, RECORD_PATH, &planned, "apollo-reverted", 40);
    pull(&mut b, 3, std::slice::from_ref(&reverted), &[&planned]);
    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        reverted.origin_seq
    );
    assert_eq!(head_text(&b, RECORD), Some(planned));
    assert_eq!(indexed_status(&b), Some(json!("Planned")));
    assert_eq!(lineage_rows(&b), 0);
    assert!(open_conflicts(&b).is_empty());
}

fn b_opens_lossy(b: &mut EngineStore, typing: &[&str]) -> Ydoc {
    let doc = richdoc(LOSSY_CANONICAL);
    assert_ne!(projected(&doc), LOSSY, "the note is lossy");
    doc.preserve_folded_markdown_source(LOSSY)
        .expect("witness the exact source");
    b_opens(b, &doc, LOSSY, typing);
    doc
}

#[test]
fn lossy_record_file_edit_conflicts_keep_the_recovery_through_each_resolution() {
    let flown = md(FLOWN);
    let merged = {
        let doc = richdoc(&flown);
        doc.richdoc_append_paragraph(NOTES);
        projected(&doc)
    };
    for (resolution, chosen) in [
        (ResolveConflictKind::KeepCurrent, LOSSY.to_owned()),
        (ResolveConflictKind::ApplyIncoming, flown.clone()),
        (
            ResolveConflictKind::ApplyMerged {
                text: merged.clone(),
            },
            merged.clone(),
        ),
    ] {
        let (_a_scratch, mut a) = device("device-a");
        let created = a_creates_apollo(&mut a, LOSSY);
        let (_b_scratch, b_path, mut b) = device_b(&created, LOSSY);
        let draft = projected(&b_opens_lossy(&mut b, &[NOTES]));
        let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
        hydrate(&mut b, &[&flown, &merged]);
        assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
        assert_eq!(recovered(&b, &draft), 1);

        resolve(&mut b, resolution);
        assert_eq!(head_text(&b, RECORD), Some(chosen.clone()));
        assert!(open_conflicts(&b).is_empty());
        assert_eq!(recovered(&b, &draft), 1, "B's typing outlives the choice");

        drop(b);
        let b = EngineStore::open(&b_path, 3_000).expect("restart B");
        assert_eq!(head_text(&b, RECORD), Some(chosen));
        assert_eq!(recovered(&b, &draft), 1);
    }
}

fn a_moves_apollo(a: &mut EngineStore) -> ReplicationEnvelope {
    let rename = RenameTextFile {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        from_path: RECORD_PATH.into(),
        to_path: MOVED_PATH.into(),
        moment_id: "apollo-moved".into(),
        request_id: None,
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 30,
    };
    a_journals(a, "apollo-moved", |tx| {
        dohc_engine_domain::rename_text_in_tx(tx, &rename, |_, _| Ok(()))
            .map_err(SyncError::corrupt)?;
        Ok(())
    })
}

#[test]
fn resolved_record_file_move_conflicts_leave_one_path() {
    let planned = md(PLANNED);
    let merged = {
        let doc = richdoc(&planned);
        doc.richdoc_append_paragraph(LOG);
        projected(&doc)
    };
    let paths = |b: &EngineStore| -> Vec<String> {
        b.read_with(|conn| {
            conn.prepare(
                "SELECT path FROM snapshots WHERE workspace_id='ws' AND path IN (?1,?2) \
                 ORDER BY path",
            )?
            .query_map(params![RECORD_PATH, MOVED_PATH], |row| row.get(0))?
            .collect()
        })
        .expect("record paths")
    };
    for (claimed, later_typing) in [(false, false), (false, true), (true, false)] {
        for choice in ["current", "incoming", "merged"] {
            let (_a_scratch, mut a) = device("device-a");
            let created = a_creates_apollo(&mut a, &planned);
            let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
            let doc = richdoc(&planned);
            if claimed {
                device_c_base(&mut b, &doc);
                assert!(open_conflicts(&b).is_empty(), "the base matches the file");
                b_types(&mut b, &mut WriterDocCache::new(), &doc, &[NOTES], 2_001);
            } else {
                b_opens(&mut b, &doc, &planned, &[NOTES]);
            }
            let draft = projected(&doc);
            let (resolution, chosen, path) = match choice {
                "current" => (
                    ResolveConflictKind::KeepCurrent,
                    draft.clone(),
                    Some(RECORD_PATH),
                ),
                "incoming" => (
                    ResolveConflictKind::ApplyIncoming,
                    planned.clone(),
                    Some(MOVED_PATH),
                ),
                _ => (
                    ResolveConflictKind::ApplyMerged {
                        text: merged.clone(),
                    },
                    merged.clone(),
                    None,
                ),
            };
            let moved = a_moves_apollo(&mut a);
            hydrate(&mut b, &[&merged]);
            assert_conflicts_opened(deliver(&mut b, &moved, &NoLiveLeases).expect("apply"), 1);
            assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&planned))]);
            let later = later_typing.then(|| {
                b_types(&mut b, &mut WriterDocCache::new(), &doc, &[LOG], 2_100);
                projected(&doc)
            });

            resolve(&mut b, resolution);
            let check = |b: &EngineStore| {
                let label = format!("claimed={claimed} later={later_typing} choice={choice}");
                if let Some(later) = &later {
                    assert_eq!(recovered(b, later), 1, "later typing survives: {label}");
                }
                let left = paths(b);
                assert_eq!(left.len(), 1, "one path remains: {label} {left:?}");
                if let Some(path) = path {
                    assert_eq!(left[0], path, "{label}");
                }
                let object = if choice == "incoming" {
                    "apollo-resolution-object"
                } else {
                    RECORD
                };
                assert_eq!(head_text(b, object), Some(chosen.clone()), "{label}");
                assert!(open_conflicts(b).is_empty(), "{label}");
                assert!(
                    history_holds(b, &draft) >= 1,
                    "History keeps B's side: {label}"
                );
                assert!(
                    history_holds(b, &planned) >= 1,
                    "History keeps A's side: {label}"
                );
            };
            check(&b);
            drop(b);
            check(&EngineStore::open(&b_path, 3_000).expect("restart B"));
        }
    }
}

#[test]
fn typing_after_a_record_conflict_opens_outlives_the_resolution() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&flown))]);
    b_types(&mut b, &mut WriterDocCache::new(), &doc, &[LOG], 2_100);
    let later = projected(&doc);
    assert_eq!(recovered(&b, &later), 0);

    resolve(&mut b, ResolveConflictKind::ApplyIncoming);
    assert_eq!(head_text(&b, RECORD), Some(flown.clone()));
    assert_eq!(
        recovered(&b, &later),
        1,
        "B's later typing outlives the choice"
    );

    drop(b);
    let b = EngineStore::open(&b_path, 3_000).expect("restart B");
    assert_eq!(head_text(&b, RECORD), Some(flown));
    assert_eq!(recovered(&b, &later), 1);
    let authors: String = b
        .read_with(|conn| {
            conn.query_row(
                "SELECT m.author_json FROM moments m WHERE m.workspace_id='ws' \
                   AND m.object_id<>?1 AND m.after_blob_sha256=?2",
                params![RECORD, sha(&later)],
                |row| row.get(0),
            )
        })
        .expect("the recovery copy's authors");
    assert!(authors.contains("typist"), "{authors}");
}

#[test]
fn record_file_edit_waiting_for_a_conflict_lets_the_rest_of_sync_move() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let splashed = format!("{flown}\nSplashed down.\n");
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_d_scratch, mut d) = device("device-d");
    hydrate(&mut d, &[SCHEMA, &planned]);
    for op in &created {
        deliver(&mut d, op, &NoLiveLeases).expect("D pulls A's record");
    }
    let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    pull(&mut b, 2, std::slice::from_ref(&flown_op), &[&flown]);
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&flown))]);
    assert!(waiting(&b).is_empty(), "nothing waits before a hold");

    // D's file comes from another branch. More unrelated work than one pass
    // fetches arrives behind it, over two pulls.
    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
    let limit = crate::model::MAX_PULL_OPS_PER_PASS as i64;
    let reactions = (0..=limit)
        .map(|seq| {
            envelope(
                "device-e",
                seq,
                "chat.reaction.set",
                reaction_payload("added", "🚀", seq, &format!("crew-{seq}")),
            )
        })
        .collect::<Vec<_>>();
    let mut first = vec![splashed_op.clone()];
    first.extend_from_slice(&reactions[..limit as usize - 1]);
    let cursor = |b: &EngineStore| {
        crate::read_relay_cursor(b, "ws")
            .expect("cursor")
            .expect("B has a cursor")
            .cursor
    };
    let ack =
        |b: &EngineStore, origin: &str| read_replication_acked_seq(b, "ws", origin).expect("ack");
    let retained = |b: &EngineStore| count(b, "SELECT COUNT(*) FROM relay_deferred_ops");
    pull(&mut b, 3, &first, &[&splashed]);
    assert_eq!(cursor(&b), 3 + limit);
    assert_eq!(ack(&b, "device-e"), limit - 2, "unrelated work applies");
    assert!(
        ack(&b, "device-d") < splashed_op.origin_seq,
        "D's file waits"
    );
    assert_eq!(retained(&b), 1);
    let held = vec![(
        RECORD.to_owned(),
        "device-d".to_owned(),
        splashed_op.origin_seq,
    )];
    assert_eq!(waiting(&b), held, "the conflict shows D's file waiting");

    pull(&mut b, 3 + limit, &reactions[limit as usize - 1..], &[]);
    assert_eq!(cursor(&b), 5 + limit);
    assert_eq!(ack(&b, "device-e"), limit, "work past one pass applies");
    assert!(ack(&b, "device-d") < splashed_op.origin_seq);
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&flown))]);
    assert_eq!(head_text(&b, RECORD), Some(draft.clone()));
    assert_eq!(waiting(&b), held, "unrelated work leaves it waiting");
    drop(b);
    let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
    assert_eq!(waiting(&b), held, "it still waits after a restart");

    resolve(&mut b, ResolveConflictKind::KeepCurrent);
    assert!(waiting(&b).is_empty(), "a resolved conflict holds nothing");
    drop(b);
    let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
    pull(&mut b, 5 + limit, &[], &[]);
    assert_eq!(
        ack(&b, "device-d"),
        splashed_op.origin_seq,
        "D's file applies"
    );
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-splashed'"
        ),
        1,
        "History holds D's edit"
    );
    assert_eq!(
        open_conflicts(&b),
        vec![(sha(&draft), sha(&splashed))],
        "D's file meets the resolved head"
    );
    assert!(
        waiting(&b).is_empty(),
        "the fresh conflict inherits nothing"
    );
    assert_eq!(cursor(&b), 5 + limit);
}

#[test]
fn record_file_edit_conflicts_survive_restart_and_redelivery_once() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    for claimed in [false, true] {
        let (_a_scratch, mut a) = device("device-a");
        let created = a_creates_apollo(&mut a, &planned);
        let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
        let replica = richdoc(&planned);
        let claim = if claimed {
            // B types into the claimed lineage, so it holds more than the
            // head A's file continues.
            let claim = device_c_base(&mut b, &replica);
            b_types(&mut b, &mut WriterDocCache::new(), &replica, &[LOG], 2_001);
            Some(claim)
        } else {
            b_opens(&mut b, &replica, &planned, &[NOTES]);
            None
        };
        let current = projected(&replica);

        let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
        hydrate(&mut b, &[&flown]);
        assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
        assert_eq!(open_conflicts(&b), vec![(sha(&current), sha(&flown))]);
        let state = |b: &EngineStore| {
            (
                open_conflicts(b),
                count(b, "SELECT COUNT(*) FROM moments"),
                count(
                    b,
                    "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'",
                ),
                side_records(b),
                head_text(b, RECORD),
            )
        };
        let decided = state(&b);
        assert_eq!(decided.3, 1);

        drop(b);
        let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
        let redelivered = deliver(&mut b, &flown_op, &NoLiveLeases).expect("redeliver");
        assert!(
            matches!(redelivered.primary, ApplyDisposition::Skipped),
            "{redelivered:?}"
        );
        assert_eq!(state(&b), decided, "claimed={claimed}");
        assert_eq!(
            read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
            flown_op.origin_seq
        );

        let Some(claim) = claim else {
            continue;
        };
        assert_eq!(
            dohc_engine_collab::read_marker(&b, &key())
                .expect("marker")
                .expect("the claimed lineage stays")
                .lineage_claim_id
                .as_deref(),
            Some(claim.as_str())
        );
        let delta = replica.richdoc_append_paragraph(NOTES);
        let delta_sha = b.put_binary_blob(&delta).expect("delta blob");
        let mut update = envelope(
            "device-c",
            1,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":RECORD, "path":RECORD_PATH,
                "contentKind":"richdoc", "updateBlobSha256":delta_sha,
                "lineageClaimId":claim, "isBaseState":false,
            }),
        );
        update.relay_seq = Some(11);
        assert!(matches!(
            apply_ydoc_envelope(
                &mut b,
                &mut WriterDocCache::new(),
                &update,
                &NoFaults,
                &NoLiveLeases
            )
            .expect("apply the replica's edit")
            .primary,
            ApplyDisposition::Applied(_)
        ));
        let edited = projected(&replica);
        assert_eq!(open_conflicts(&b), vec![(sha(&edited), sha(&flown))]);
        assert_eq!(head_text(&b, RECORD), Some(edited));
    }
}

#[test]
fn resolved_record_file_edit_conflicts_keep_the_choice_after_restart() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let merged = {
        let doc = richdoc(&flown);
        doc.richdoc_append_paragraph(NOTES);
        projected(&doc)
    };
    for claimed in [false, true] {
        for choice in ["current", "incoming", "merged"] {
            let (_a_scratch, mut a) = device("device-a");
            let created = a_creates_apollo(&mut a, &planned);
            let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
            let doc = richdoc(&planned);
            if claimed {
                device_c_base(&mut b, &doc);
                b_types(&mut b, &mut WriterDocCache::new(), &doc, &[NOTES], 2_001);
            } else {
                b_opens(&mut b, &doc, &planned, &[NOTES]);
            }
            let current = projected(&doc);
            let (resolution, chosen) = match choice {
                "current" => (ResolveConflictKind::KeepCurrent, current.clone()),
                "incoming" => (ResolveConflictKind::ApplyIncoming, flown.clone()),
                _ => (
                    ResolveConflictKind::ApplyMerged {
                        text: merged.clone(),
                    },
                    merged.clone(),
                ),
            };
            let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
            hydrate(&mut b, &[&flown, &merged]);
            assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
            assert_eq!(open_conflicts(&b), vec![(sha(&current), sha(&flown))]);

            resolve(&mut b, resolution);
            assert_eq!(head_text(&b, RECORD), Some(chosen.clone()));
            assert!(open_conflicts(&b).is_empty());

            drop(b);
            let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
            let redelivered = deliver(&mut b, &flown_op, &NoLiveLeases).expect("redeliver");
            assert!(
                matches!(redelivered.primary, ApplyDisposition::Skipped),
                "{redelivered:?}"
            );
            assert_eq!(head_text(&b, RECORD), Some(chosen.clone()));
            assert_eq!(lineage_text(&b), chosen, "the next open shows the choice");
            assert!(open_conflicts(&b).is_empty());

            // A reverts its flown file to the planned bytes. When B chose the
            // flown file, the revert builds on the choice and comes in.
            // Otherwise it meets the choice, never the side the resolution
            // discarded.
            let label = format!("claimed={claimed} choice={choice}");
            let reverted = a_saves(&mut a, RECORD, RECORD_PATH, &planned, "apollo-reverted", 40);
            hydrate(&mut b, &[&planned]);
            let applied = deliver(&mut b, &reverted, &NoLiveLeases).expect("apply the revert");
            if chosen == planned || choice == "incoming" {
                assert_conflicts_opened(applied, 0);
                assert_eq!(head_text(&b, RECORD), Some(planned.clone()), "{label}");
                assert!(open_conflicts(&b).is_empty(), "{label}");
                if choice == "incoming" {
                    assert_eq!(
                        lineage_rows(&b),
                        0,
                        "the choice's lineage gives way: {label}"
                    );
                }
            } else {
                assert_conflicts_opened(applied, 1);
                assert_eq!(
                    open_conflicts(&b),
                    vec![(sha(&chosen), sha(&planned))],
                    "claimed={claimed} choice={choice}"
                );
                assert_eq!(head_text(&b, RECORD), Some(chosen));
            }
        }
    }
}

#[test]
fn a_save_from_the_head_of_a_claimed_record_comes_in() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
    let replica = richdoc(&planned);
    let claim = device_c_base(&mut b, &replica);
    assert!(open_conflicts(&b).is_empty(), "the base matches the file");

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 0);
    assert_eq!(head_text(&b, RECORD), Some(flown.clone()));
    assert_eq!(indexed_status(&b), Some(json!("Flown")));
    assert_eq!(lineage_rows(&b), 0, "the claimed lineage gives way");
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE object_id='apollo'"
        ),
        1,
        "the claimed lineage is archived"
    );

    drop(b);
    let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
    let delta = replica.richdoc_append_paragraph(NOTES);
    let delta_sha = b.put_binary_blob(&delta).expect("delta blob");
    let mut update = envelope(
        "device-c",
        1,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":RECORD, "path":RECORD_PATH,
            "contentKind":"richdoc", "updateBlobSha256":delta_sha,
            "lineageClaimId":claim, "isBaseState":false,
        }),
    );
    update.relay_seq = Some(11);
    apply_ydoc_envelope(
        &mut b,
        &mut WriterDocCache::new(),
        &update,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply the late edit");
    let edited = projected(&replica);
    assert_eq!(recovered(&b, &edited), 1, "a recovery copy keeps C's edit");
    assert_eq!(head_text(&b, RECORD), Some(flown));
    assert!(open_conflicts(&b).is_empty());
}

#[test]
fn a_save_from_the_head_meets_a_record_bound_to_live_editing() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let claim = device_c_base(&mut b, &richdoc(&planned));
    b.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO live_device_application_bindings VALUES \
             ('relay','ws','main',?1,?2,?3,'[]',0,'host',1,'instance','connection',1,NULL)",
            params![RECORD, claim, RECORD_PATH],
        )
        .map_err(SyncError::persist)
    })
    .expect("bind a device");

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
    assert_eq!(open_conflicts(&b), vec![(sha(&planned), sha(&flown))]);
    assert_eq!(head_text(&b, RECORD), Some(planned));
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE object_id='apollo'"
        ),
        0,
        "the bound lineage stays active"
    );
}

#[test]
fn record_file_edit_held_by_a_live_session_converges_after_it_closes() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    b_opens(&mut b, &richdoc(&planned), &planned, &[]);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);

    let leases = LeaseRegistry::new();
    let held = leases.acquire(&key()).expect("open the record");
    assert!(matches!(
        deliver(&mut b, &flown_op, &leases),
        Err(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert!(read_replication_acked_seq(&b, "ws", "device-a").expect("ack") < flown_op.origin_seq);
    assert_eq!(head_text(&b, RECORD), Some(planned));

    drop(held);
    let applied = deliver(&mut b, &flown_op, &leases).expect("apply after close");
    assert!(
        matches!(applied.primary, ApplyDisposition::Applied(_)),
        "{applied:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        flown_op.origin_seq
    );
    assert_eq!(head_text(&b, RECORD), Some(flown));
    assert_eq!(indexed_status(&b), Some(json!("Flown")));
    assert_eq!(lineage_rows(&b), 0);
    assert!(open_conflicts(&b).is_empty());
}

fn waiting(b: &EngineStore) -> Vec<(String, String, i64)> {
    let ids: Vec<String> = b
        .read_with(|conn| {
            conn.prepare(
                "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' AND status='open' \
                 ORDER BY created_at_ms,conflict_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .expect("open conflict ids");
    let ids = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let mut found = crate::waiting_versions(b, "ws", &ids).expect("waiting versions");
    ids.iter()
        .filter_map(|id| found.remove(*id))
        .map(|held| (held.object_id, held.origin_id, held.origin_seq))
        .collect()
}

fn b_holds_a_conflict() -> (Vec<ScratchDir>, EngineStore, EngineStore, EngineStore) {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (d_scratch, mut d) = device("device-d");
    hydrate(&mut d, &[SCHEMA, &planned]);
    for op in &created {
        deliver(&mut d, op, &NoLiveLeases).expect("D pulls A's record");
    }
    let (b_scratch, _b_path, mut b) = device_b(&created, &planned);
    b_opens(&mut b, &richdoc(&planned), &planned, &[NOTES]);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    pull(&mut b, 2, std::slice::from_ref(&flown_op), &[&flown]);
    assert_eq!(open_conflicts(&b).len(), 1);
    (vec![a_scratch, b_scratch, d_scratch], a, b, d)
}

fn from_origin(op: &ReplicationEnvelope, origin: &str, seq: i64) -> ReplicationEnvelope {
    let mut op = op.clone();
    op.origin_id = origin.into();
    op.origin_seq = seq;
    op
}

fn b_retains(b: &mut EngineStore, ops: &[ReplicationEnvelope], texts: &[&str]) {
    hydrate(b, texts);
    let identity = read_sync_identity(b, "ws")
        .expect("identity")
        .expect("B has an identity");
    let ops = ops.iter().collect::<Vec<_>>();
    crate::deferred::retain(b, &identity, None, &ops, &NoFaults).expect("retain");
}

#[test]
fn saves_of_another_file_or_version_are_not_waiting_versions() {
    let (_scratch, _a, mut b, mut d) = b_holds_a_conflict();
    let gemini_op = a_saves(&mut d, "gemini", GEMINI_PATH, GEMINI, "gemini-saved", 45);
    let splashed = format!("{}\nSplashed down.\n", md(FLOWN));
    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
    let mut elsewhere = from_origin(&splashed_op, "device-g", 0);
    elsewhere.payload["versionId"] = json!("draft");
    b_retains(
        &mut b,
        &[from_origin(&gemini_op, "device-f", 0), elsewhere],
        &[GEMINI, &splashed],
    );
    assert!(waiting(&b).is_empty());
}

#[test]
fn only_the_first_retained_save_of_an_origin_is_a_waiting_version() {
    let (_scratch, _a, mut b, mut d) = b_holds_a_conflict();
    let gemini_op = a_saves(&mut d, "gemini", GEMINI_PATH, GEMINI, "gemini-saved", 45);
    let splashed = format!("{}\nSplashed down.\n", md(FLOWN));
    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
    let crewed = format!("{splashed}\nCrew home.\n");
    let crewed_op = a_saves(&mut d, RECORD, RECORD_PATH, &crewed, "apollo-crewed", 60);
    b_retains(
        &mut b,
        &[
            from_origin(&gemini_op, "device-f", 0),
            from_origin(&splashed_op, "device-f", 1),
        ],
        &[GEMINI, &splashed],
    );
    assert!(waiting(&b).is_empty(), "D's save waits on Gemini");

    b_retains(
        &mut b,
        &[
            from_origin(&splashed_op, "device-g", 0),
            from_origin(&crewed_op, "device-g", 1),
        ],
        &[&splashed, &crewed],
    );
    assert_eq!(
        waiting(&b),
        vec![(RECORD.to_owned(), "device-g".to_owned(), 0)],
        "the first held save is the one waiting"
    );
}

#[test]
fn an_applied_retained_save_is_not_a_waiting_version() {
    let (_scratch, _a, mut b, mut d) = b_holds_a_conflict();
    let splashed = format!("{}\nSplashed down.\n", md(FLOWN));
    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
    b_retains(
        &mut b,
        &[from_origin(&splashed_op, "device-f", 0)],
        &[&splashed],
    );
    assert_eq!(waiting(&b).len(), 1);
    b.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO replication_peers(workspace_id,origin_id,acked_seq) \
             VALUES('ws','device-f',0) \
             ON CONFLICT(workspace_id,origin_id) DO UPDATE SET acked_seq=0",
            [],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })
    .expect("device-f applied");
    assert!(waiting(&b).is_empty());
}
