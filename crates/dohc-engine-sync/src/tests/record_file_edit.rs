//! A Collection record saved as a file on a device that never held its
//! Y.Doc reaches a device whose copy holds a lineage for that record.

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

/// A rich document holding `markdown`, as the desktop adopts a record.
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

/// A device that saves files and never opens the record, so it holds no
/// lineage.
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

/// Run `change` on A and return the envelope A journals for `moment`.
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

/// Save `text` on A and return the envelope A journals for it.
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

/// A creates the Collection and Apollo holding `apollo`.
fn a_creates_apollo(a: &mut EngineStore, apollo: &str) -> Vec<ReplicationEnvelope> {
    vec![
        a_saves(a, "missions-schema", SCHEMA_PATH, SCHEMA, "schema-saved", 10),
        a_saves(a, RECORD, RECORD_PATH, apollo, "apollo-planned", 20),
    ]
}

/// Deliver `ops` to `b` through one relay page that starts at `from`, then
/// commit the cursor the pull reached.
fn pull(b: &mut EngineStore, from: i64, ops: &[ReplicationEnvelope], texts: &[&str]) {
    let next = from + ops.len() as i64;
    let mut relay = PagedRelay::new([(
        from,
        PullResponse {
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
        .pull_chat_workspace(b, &mut WriterDocCache::new(), "ws", &NoFaults, &leases, 2_100)
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

/// Device B pulls the Collection and Apollo as A created them.
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

fn b_types(
    b: &mut EngineStore,
    cache: &mut WriterDocCache,
    doc: &Ydoc,
    typing: &[&str],
    at: i64,
) {
    let attribution = ChangeAttribution {
        actor_kind: ChangeActorKind::Human,
        on_behalf_of: None,
        depth: 0,
        run: None,
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

/// B settles `text` as its record session does.
fn b_settles(b: &mut EngineStore, text: &str) {
    b.write_with(&NoFaults, |tx| {
        let result = dohc_engine_domain::write_projected_text_in_tx(
            tx,
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: RECORD.into(),
                path: RECORD_PATH.into(),
                text: text.into(),
                moment_id: "apollo-b1".into(),
                metadata_origin: "ydoc".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_050,
                request_id: None,
            },
        )
        .map_err(crate::ydoc_apply::map_domain_hard_error)?;
        tx.execute(
            "UPDATE ydoc_docs SET settle_seq=?1,last_settled_sha=?2 WHERE object_id=?3",
            params![
                result.moment.moment_order,
                result.snapshot.blob_sha256,
                RECORD
            ],
        )
        .map_err(SyncError::persist)?;
        dohc_engine_collab::author_coverage::advance_in(tx, &key(), false)
            .map_err(SyncError::corrupt)?;
        Ok::<_, SyncError>(())
    })
    .expect("B settles its edit");
}

/// Another device's Y.Doc base for Apollo, which claims B's lineage.
fn device_c_base(b: &mut EngineStore, doc: &Ydoc) -> String {
    let sha = b.put_binary_blob(&doc.encode_full_state()).expect("base blob");
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
        apply_ydoc_envelope(b, &mut WriterDocCache::new(), &base, &NoFaults, &NoLiveLeases)
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

fn head_authors(b: &EngineStore) -> Option<String> {
    b.read_with(|conn| {
        conn.query_row(
            "SELECT m.author_json FROM snapshots s JOIN moments m \
               ON m.workspace_id=s.workspace_id AND m.moment_id=s.latest_moment_id \
             WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id=?1",
            [RECORD],
            |row| row.get(0),
        )
    })
    .expect("head authors")
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

/// The open conflicts' current and incoming bytes.
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

/// How many History moments hold `text`.
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
        object_id: RECORD.into(),
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
        count(&b, "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"),
        1,
        "History holds A's edit"
    );
    assert_eq!(lineage_rows(&b), 0, "the untouched seed retires");
    assert!(open_conflicts(&b).is_empty());

    // The next open seeds a fresh lineage from the file A wrote.
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

#[test]
fn record_file_edit_meets_unsettled_record_edits_in_a_conflict_holding_both() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    let gemini = a_saves(&mut a, "gemini", GEMINI_PATH, GEMINI, "gemini-saved", 31);
    pull(&mut b, 2, &[flown_op, gemini.clone()], &[&flown, GEMINI]);

    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        gemini.origin_seq,
        "unrelated sync keeps moving"
    );
    assert_eq!(head_text(&b, "gemini").as_deref(), Some(GEMINI));
    assert_eq!(
        open_conflicts(&b),
        vec![(sha(&draft), sha(&flown))],
        "the conflict holds B's edit and A's file"
    );
    assert_eq!(head_text(&b, RECORD), Some(draft.clone()));
    assert!(
        head_authors(&b).is_some_and(|authors| authors.contains("typist")),
        "History names who typed B's edit"
    );
    assert_eq!(
        count(&b, "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"),
        1,
        "History holds A's edit"
    );
    assert_eq!(
        count(&b, "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'"),
        2,
        "B keeps its updates"
    );
    assert_eq!(lineage_text(&b), draft);
    assert_eq!(side_records(&b), 1);
}

/// A lossy note's projection never replaces its exact source unchecked. The
/// conflict holds that source beside A's file instead of waiting forever.
#[test]
fn record_file_edit_meets_a_lossy_note_in_a_conflict_holding_its_exact_source() {
    let flown = md(FLOWN);
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, LOSSY);
    let (_b_scratch, _b_path, mut b) = device_b(&created, LOSSY);
    let doc = richdoc(LOSSY_CANONICAL);
    assert_ne!(projected(&doc), LOSSY, "the note is lossy");
    doc.preserve_folded_markdown_source(LOSSY)
        .expect("witness the exact source");
    b_opens(&mut b, &doc, LOSSY, &[NOTES]);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);

    assert_eq!(open_conflicts(&b), vec![(sha(LOSSY), sha(&flown))]);
    assert_eq!(head_text(&b, RECORD).as_deref(), Some(LOSSY));
    assert_eq!(
        count(&b, "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"),
        1,
        "History holds A's edit"
    );
    assert_eq!(
        count(&b, "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'"),
        2,
        "B keeps its typing"
    );
    assert_eq!(side_records(&b), 1);
    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        flown_op.origin_seq
    );
}

/// A file moved on a device without the lineage meets B's unsettled edits in
/// a conflict instead of waiting forever.
#[test]
fn record_file_move_meets_unsettled_record_edits_in_a_conflict() {
    let planned = md(PLANNED);
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);

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
    let moved = a_journals(&mut a, "apollo-moved", |tx| {
        dohc_engine_domain::rename_text_in_tx(tx, &rename, |_, _| Ok(()))
            .map_err(SyncError::corrupt)?;
        Ok(())
    });
    assert_conflicts_opened(deliver(&mut b, &moved, &NoLiveLeases).expect("apply"), 1);

    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&planned))]);
    assert_eq!(head_text(&b, RECORD), Some(draft.clone()));
    assert_eq!(lineage_text(&b), draft);
    assert_eq!(side_records(&b), 1);
    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        moved.origin_seq
    );
}

/// B settled one edit and keeps typing. A file written over the older head
/// meets B's latest edits, and choosing A's file keeps them in History.
#[test]
fn record_file_edit_from_an_older_head_keeps_unsettled_edits_in_the_current_side() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let settled = projected(&doc);
    b_settles(&mut b, &settled);
    b_types(&mut b, &mut WriterDocCache::new(), &doc, &[LOG], 2_060);
    let latest = projected(&doc);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);

    assert_eq!(
        open_conflicts(&b),
        vec![(sha(&latest), sha(&flown))],
        "the current side holds B's unsettled edit"
    );
    assert_eq!(head_text(&b, RECORD), Some(latest.clone()));
    assert_eq!(side_records(&b), 1, "the Y.Doc moves the current side");

    resolve(&mut b, ResolveConflictKind::ApplyIncoming);
    assert_eq!(head_text(&b, RECORD), Some(flown));
    assert!(open_conflicts(&b).is_empty());
    assert!(history_holds(&b, &latest) >= 1, "History keeps B's edit");
}

/// One conflict per object. A file that continues the conflict's incoming
/// side updates it. A file from another branch waits for the resolution.
#[test]
fn record_file_edit_on_another_branch_waits_for_the_open_conflict() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let landed = format!("{flown}\nLanded.\n");
    let splashed = format!("{flown}\nSplashed down.\n");
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_d_scratch, mut d) = device("device-d");
    hydrate(&mut d, &[SCHEMA, &planned]);
    for op in &created {
        assert!(matches!(
            deliver(&mut d, op, &NoLiveLeases)
                .expect("D pulls A's record")
                .primary,
            ApplyDisposition::Applied(_)
        ));
    }
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown, &landed, &splashed]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);

    let landed_op = a_saves(&mut a, RECORD, RECORD_PATH, &landed, "apollo-landed", 40);
    assert_conflicts_opened(
        deliver(&mut b, &landed_op, &NoLiveLeases).expect("apply A's next edit"),
        0,
    );
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&landed))]);

    let splashed_op = a_saves(&mut d, RECORD, RECORD_PATH, &splashed, "apollo-splashed", 50);
    assert!(
        matches!(
            deliver(&mut b, &splashed_op, &NoLiveLeases),
            Err(SyncError::RetryableState {
                reason: crate::moment_apply::RESOLVE_EXISTING_CONFLICT
            })
        ),
        "D's edit waits for the open conflict"
    );
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&landed))]);
    assert_eq!(head_text(&b, RECORD), Some(draft));
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
            Some(device_c_base(&mut b, &replica))
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
                count(b, "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'"),
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
        // The replica keeps editing. Its projection moves the Y.Doc's side
        // of the conflict and never replaces A's file.
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

/// Each resolution keeps its choice after a restart, on a lineage only B
/// holds and on one another device claimed. A later file meets the choice.
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

            // A reverts its file to the planned bytes. B's lineage holds the
            // choice, so the revert meets the choice, never the side the
            // resolution discarded.
            let reverted = a_saves(&mut a, RECORD, RECORD_PATH, &planned, "apollo-reverted", 40);
            hydrate(&mut b, &[&planned]);
            let applied = deliver(&mut b, &reverted, &NoLiveLeases).expect("apply the revert");
            if chosen == planned {
                assert_conflicts_opened(applied, 0);
                assert_eq!(head_text(&b, RECORD), Some(planned.clone()));
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
