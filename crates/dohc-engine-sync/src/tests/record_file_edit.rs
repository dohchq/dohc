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
const LANDED: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nStatus: Landed\n---\n# Apollo\n";
const RECOVERED: &str =
    "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nStatus: Recovered\n---\n# Apollo\n";
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

/// Deliver `ops` to `b` through one relay page that starts at `from`, then
/// commit the cursor the pull reached.
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
        count(
            &b,
            "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"
        ),
        1,
        "History holds A's edit"
    );
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'"
        ),
        2,
        "B keeps its updates"
    );
    assert_eq!(lineage_text(&b), draft);
    assert_eq!(side_records(&b), 1);
}

/// B's lossy note, holding `typing` it never settled.
fn b_opens_lossy(b: &mut EngineStore, typing: &[&str]) -> Ydoc {
    let doc = richdoc(LOSSY_CANONICAL);
    assert_ne!(projected(&doc), LOSSY, "the note is lossy");
    doc.preserve_folded_markdown_source(LOSSY)
        .expect("witness the exact source");
    b_opens(b, &doc, LOSSY, typing);
    doc
}

/// A lossy note's projection never replaces its exact source unchecked. The
/// conflict holds that source beside A's file instead of waiting forever,
/// and a recovery copy keeps B's typing.
#[test]
fn record_file_edit_meets_a_lossy_note_in_a_conflict_holding_its_exact_source() {
    let flown = md(FLOWN);
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, LOSSY);
    let (_b_scratch, _b_path, mut b) = device_b(&created, LOSSY);
    let draft = projected(&b_opens_lossy(&mut b, &[NOTES]));

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);

    assert_eq!(open_conflicts(&b), vec![(sha(LOSSY), sha(&flown))]);
    assert_eq!(head_text(&b, RECORD).as_deref(), Some(LOSSY));
    assert_eq!(recovered(&b, &draft), 1, "a recovery copy keeps B's typing");
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM ydoc_docs WHERE object_id='apollo' \
               AND settled_update_seq=head_update_seq AND settle_prior_update_seq IS NULL \
               AND pending_authors_json='[]'"
        ),
        1,
        "the copy consumed its authors, so no later projection credits them again"
    );
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM moments WHERE moment_id='apollo-flown'"
        ),
        1,
        "History holds A's edit"
    );
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='apollo'"
        ),
        2,
        "B keeps its typing"
    );
    assert_eq!(side_records(&b), 1);
    assert_eq!(
        read_replication_acked_seq(&b, "ws", "device-a").expect("ack"),
        flown_op.origin_seq
    );
}

/// Each resolution of a lossy note's conflict keeps the recovery copy of
/// B's typing, after a restart too.
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

/// A replica's later edit to a lossy note under its conflict cannot replace
/// the exact source. The source stays the current side, the lineage keeps
/// the edit, and the recovery copy of the earlier typing stays.
#[test]
fn lossy_record_conflict_keeps_its_exact_source_under_a_later_replica_edit() {
    let flown = md(FLOWN);
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, LOSSY);
    let (_b_scratch, _b_path, mut b) = device_b(&created, LOSSY);
    let replica = richdoc(LOSSY_CANONICAL);
    replica
        .preserve_folded_markdown_source(LOSSY)
        .expect("witness the exact source");
    let claim = b
        .put_binary_blob(&replica.encode_full_state())
        .expect("base blob");
    let update = |seq: i64, blob: &str| {
        let mut op = envelope(
            "device-c",
            seq,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":RECORD, "path":RECORD_PATH,
                "contentKind":"richdoc", "updateBlobSha256":blob,
                "lineageClaimId":claim, "isBaseState":(seq == 0),
            }),
        );
        op.relay_seq = Some(10 + seq);
        op
    };
    apply_ydoc_envelope(
        &mut b,
        &mut WriterDocCache::new(),
        &update(0, &claim),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("the replica's base arrives");
    assert!(open_conflicts(&b).is_empty(), "the base matches the file");
    // B types into the claimed lineage and never settles.
    let local = Ydoc::wire();
    local
        .apply(&replica.encode_full_state())
        .expect("B holds the base");
    b_types(&mut b, &mut WriterDocCache::new(), &local, &[NOTES], 2_001);
    let draft = projected(&local);

    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
    assert_eq!(open_conflicts(&b), vec![(sha(LOSSY), sha(&flown))]);
    assert_eq!(recovered(&b, &draft), 1);

    let delta = replica.richdoc_append_paragraph(LOG);
    let delta_sha = b.put_binary_blob(&delta).expect("delta blob");
    apply_ydoc_envelope(
        &mut b,
        &mut WriterDocCache::new(),
        &update(1, &delta_sha),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("the replica's later edit arrives");
    assert_eq!(
        open_conflicts(&b),
        vec![(sha(LOSSY), sha(&flown))],
        "the exact source stays the current side"
    );
    assert_eq!(head_text(&b, RECORD).as_deref(), Some(LOSSY));
    local.apply(&delta).expect("merge the replica's edit");
    assert_eq!(
        lineage_text(&b),
        projected(&local),
        "the lineage keeps the edit"
    );
    assert_eq!(recovered(&b, &draft), 1);
}

/// A moves Apollo to MOVED_PATH and returns the envelope A journals.
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

    let moved = a_moves_apollo(&mut a);
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

/// Each resolution of a move conflict leaves the record at one path, on a
/// lineage only B holds and on one another device claimed. History keeps
/// both sides' bytes, after a restart too.
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

/// Typing added after the conflict opened is on neither side. Choosing A's
/// file keeps it as a recovery copy naming its typist, after a restart too.
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

    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
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

/// A file from another branch waits for the open conflict even when the
/// lineage would settle to it, so it neither opens a second conflict nor
/// moves the head.
#[test]
fn record_file_edit_the_lineage_would_settle_to_waits_for_the_open_conflict() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_d_scratch, mut d) = device("device-d");
    hydrate(&mut d, &[SCHEMA, &planned]);
    for op in &created {
        deliver(&mut d, op, &NoLiveLeases).expect("D pulls A's record");
    }
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let draft = projected(&doc);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);

    // B keeps typing under the conflict, and D saves exactly what B's
    // lineage now holds.
    b_types(&mut b, &mut WriterDocCache::new(), &doc, &[LOG], 2_100);
    let latest = projected(&doc);
    assert_eq!(lineage_text(&b), latest);
    let same_op = a_saves(&mut d, RECORD, RECORD_PATH, &latest, "apollo-same", 50);
    hydrate(&mut b, &[&latest]);
    assert!(
        matches!(
            deliver(&mut b, &same_op, &NoLiveLeases),
            Err(SyncError::RetryableState {
                reason: crate::moment_apply::RESOLVE_EXISTING_CONFLICT
            })
        ),
        "D's file waits for the open conflict"
    );
    assert_eq!(open_conflicts(&b), vec![(sha(&draft), sha(&flown))]);
    assert_eq!(head_text(&b, RECORD), Some(draft));
    assert_eq!(lineage_text(&b), latest);
}

/// A file waiting for an open conflict waits alone. Pulls retain it, apply
/// more unrelated work than one pass fetches, and move the cursor. After the
/// person resolves and B restarts, the next pull applies the retained file.
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

/// Work held behind a conflict that passes the retention limit says which
/// conflict to resolve, under its own code.
#[test]
fn conflict_held_work_past_the_retention_limit_names_the_conflict() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    let splashed = format!("{flown}\nSplashed down.\n");
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_d_scratch, mut d) = device("device-d");
    hydrate(&mut d, &[SCHEMA, &planned]);
    for op in &created {
        deliver(&mut d, op, &NoLiveLeases).expect("D pulls A's record");
    }
    let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
    let doc = richdoc(&planned);
    b_opens(&mut b, &doc, &planned, &[NOTES]);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    pull(&mut b, 2, std::slice::from_ref(&flown_op), &[&flown]);
    let splashed_op = a_saves(
        &mut d,
        RECORD,
        RECORD_PATH,
        &splashed,
        "apollo-splashed",
        50,
    );
    pull(&mut b, 3, std::slice::from_ref(&splashed_op), &[&splashed]);
    assert_eq!(count(&b, "SELECT COUNT(*) FROM relay_deferred_ops"), 1);

    // The retained work fills the limit, and D sends one more file.
    b.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE relay_deferred_ops SET retained_bytes=536870912", [])
            .map_err(SyncError::persist)
    })
    .expect("fill the retention limit");
    let gemini = a_saves(&mut d, "gemini", GEMINI_PATH, GEMINI, "gemini-saved", 60);
    hydrate(&mut b, &[GEMINI]);
    let mut relay = PagedRelay::new([(
        4,
        PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![gemini],
            next_cursor: 5,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha(GEMINI), GEMINI.as_bytes().to_vec());
    let result = RelaySyncClient::new(relay).pull_chat_workspace(
        &mut b,
        &mut WriterDocCache::new(),
        "ws",
        &NoFaults,
        &LeaseRegistry::new(),
        2_200,
    );
    let Err(RelayError::Local(detail)) = result else {
        panic!("{result:?}");
    };
    assert!(
        detail.starts_with(&format!(
            "conflict-wait-limit: Changes from another computer are waiting on the conflict in \
             {RECORD_PATH}. They reached a limit, so dohc stopped receiving changes. Resolve the \
             conflict to receive changes again. (path {RECORD_PATH}, origin device-d seq "
        )),
        "{detail}"
    );
    assert!(
        detail.ends_with("retained ops 1, retained bytes 536870912)"),
        "{detail}"
    );
    assert_eq!(head_text(&b, "gemini"), None);
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
/// holds and on one another device claimed. A later file that builds on the
/// choice comes in. Any other later file meets the choice.
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

/// After B takes A's flown file, A's next saves build on the choice. They come
/// in without a conflict, after a restart and a redelivery too. A keeps the
/// flown file, so it needs nothing from B to build on the choice.
#[test]
fn saves_that_build_on_an_applied_incoming_file_of_an_unclaimed_record_come_in() {
    let (planned, flown, landed, recovered_text) =
        (md(PLANNED), md(FLOWN), md(LANDED), md(RECOVERED));
    let (_a_scratch, mut a) = device("device-a");
    let created = a_creates_apollo(&mut a, &planned);
    let (_b_scratch, b_path, mut b) = device_b(&created, &planned);
    // B types into the record, so A's file meets that typing in a conflict.
    b_opens(&mut b, &richdoc(&planned), &planned, &[NOTES]);
    let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
    hydrate(&mut b, &[&flown, &landed, &recovered_text]);
    assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
    resolve(&mut b, ResolveConflictKind::ApplyIncoming);
    assert_eq!(head_text(&b, RECORD), Some(flown.clone()));

    let landed_op = a_saves(&mut a, RECORD, RECORD_PATH, &landed, "apollo-landed", 40);
    assert_conflicts_opened(
        deliver(&mut b, &landed_op, &NoLiveLeases).expect("apply A's save"),
        0,
    );
    let check = |b: &EngineStore| {
        assert!(open_conflicts(b).is_empty());
        assert_eq!(head_text(b, RECORD), Some(landed.clone()));
        assert_eq!(indexed_status(b), Some(json!("Landed")));
    };
    check(&b);
    assert_eq!(lineage_rows(&b), 0, "the choice's lineage gives way");

    drop(b);
    let mut b = EngineStore::open(&b_path, 3_000).expect("restart B");
    check(&b);
    let redelivered = deliver(&mut b, &landed_op, &NoLiveLeases).expect("redeliver");
    assert!(
        matches!(redelivered.primary, ApplyDisposition::Skipped),
        "{redelivered:?}"
    );
    check(&b);

    let recovered_op = a_saves(
        &mut a,
        RECORD,
        RECORD_PATH,
        &recovered_text,
        "apollo-recovered",
        50,
    );
    assert_conflicts_opened(
        deliver(&mut b, &recovered_op, &NoLiveLeases).expect("apply A's next save"),
        0,
    );
    assert!(open_conflicts(&b).is_empty());
    assert_eq!(head_text(&b, RECORD), Some(recovered_text));
    assert_eq!(indexed_status(&b), Some(json!("Recovered")));
}

/// A claimed record that never met a conflict takes a save from its head. The
/// claimed lineage gives way, and a late edit to it becomes a recovery copy.
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

    // Device C keeps editing the lineage B archived.
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

/// A claimed record that a device here applies live edits to keeps its lineage
/// and meets a save from its head in a conflict.
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

/// A save from the flown file B discarded still meets the choice when A never
/// received it.
#[test]
fn a_save_from_a_discarded_side_still_meets_the_choice() {
    let (planned, flown, landed) = (md(PLANNED), md(FLOWN), md(LANDED));
    let merged = {
        let doc = richdoc(&flown);
        doc.richdoc_append_paragraph(NOTES);
        projected(&doc)
    };
    for claimed in [false, true] {
        for choice in ["current", "merged"] {
            let label = format!("claimed={claimed} choice={choice}");
            let (_a_scratch, mut a) = device("device-a");
            let created = a_creates_apollo(&mut a, &planned);
            let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
            let doc = richdoc(&planned);
            if claimed {
                device_c_base(&mut b, &doc);
                b_types(&mut b, &mut WriterDocCache::new(), &doc, &[NOTES], 2_001);
            } else {
                b_opens(&mut b, &doc, &planned, &[NOTES]);
            }
            let (resolution, chosen) = match choice {
                "current" => (ResolveConflictKind::KeepCurrent, projected(&doc)),
                _ => (
                    ResolveConflictKind::ApplyMerged {
                        text: merged.clone(),
                    },
                    merged.clone(),
                ),
            };
            let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
            hydrate(&mut b, &[&flown, &merged, &landed]);
            assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
            resolve(&mut b, resolution);

            let landed_op = a_saves(&mut a, RECORD, RECORD_PATH, &landed, "apollo-landed", 40);
            assert_conflicts_opened(
                deliver(&mut b, &landed_op, &NoLiveLeases).expect("apply A's save"),
                1,
            );
            assert_eq!(
                open_conflicts(&b),
                vec![(sha(&chosen), sha(&landed))],
                "{label}"
            );
            assert_eq!(head_text(&b, RECORD), Some(chosen), "{label}");
        }
    }
}

/// A save from the head still meets typing B never settled, on a lineage only
/// B holds and on one another device claimed.
#[test]
fn a_save_from_the_head_meets_unsettled_record_typing() {
    let (planned, flown) = (md(PLANNED), md(FLOWN));
    for claimed in [false, true] {
        let (_a_scratch, mut a) = device("device-a");
        let created = a_creates_apollo(&mut a, &planned);
        let (_b_scratch, _b_path, mut b) = device_b(&created, &planned);
        let doc = richdoc(&planned);
        if claimed {
            device_c_base(&mut b, &doc);
            b_types(&mut b, &mut WriterDocCache::new(), &doc, &[NOTES], 2_001);
        } else {
            b_opens(&mut b, &doc, &planned, &[NOTES]);
        }
        let draft = projected(&doc);

        let flown_op = a_saves(&mut a, RECORD, RECORD_PATH, &flown, "apollo-flown", 30);
        hydrate(&mut b, &[&flown]);
        assert_conflicts_opened(deliver(&mut b, &flown_op, &NoLiveLeases).expect("apply"), 1);
        assert_eq!(
            open_conflicts(&b),
            vec![(sha(&draft), sha(&flown))],
            "claimed={claimed}"
        );
        assert_eq!(
            head_text(&b, RECORD),
            Some(draft.clone()),
            "claimed={claimed}"
        );
        assert_eq!(lineage_text(&b), draft, "claimed={claimed}");
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

/// A bare marker, like the one an owner stop leaves on an unenrolled file,
/// holds nothing another device could have. A resolution retires it even when
/// an earlier lineage of the same object journaled an update.
#[test]
fn a_resolution_retires_a_bare_lineage_whatever_an_earlier_lineage_journaled() {
    let (_scratch, mut b) = device("device-b");
    a_creates_apollo(&mut b, &md(PLANNED));
    b.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,\
             head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms) \
             VALUES('ws','main',?1,'richdoc','local-only',0,0,'unclaimed',1)",
            [RECORD],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,\
             recorded_at_ms,imported) VALUES('ws','device-c',0,'ydoc.update',?1,1,1)",
            [json!({ "versionId": "main", "objectId": RECORD }).to_string()],
        )
        .map_err(SyncError::persist)?;
        crate::ydoc_apply::retire_unclaimed_resolution_lineage_in_tx(tx, &key(), 2)
    })
    .expect("a bare lineage retires");
    assert_eq!(lineage_rows(&b), 0);
}

/// Each open conflict's waiting version, as object, origin and sequence, in
/// the order the conflicts opened.
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

/// B holds an open conflict between its typing and A's Flown file. A and D
/// hold the record as A created it.
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

/// `op` as the save at `seq` from a computer named `origin`.
fn from_origin(op: &ReplicationEnvelope, origin: &str, seq: i64) -> ReplicationEnvelope {
    let mut op = op.clone();
    op.origin_id = origin.into();
    op.origin_seq = seq;
    op
}

/// B retains `ops` unapplied, as a pull does with work held behind them.
fn b_retains(b: &mut EngineStore, ops: &[ReplicationEnvelope], texts: &[&str]) {
    hydrate(b, texts);
    let identity = read_sync_identity(b, "ws")
        .expect("identity")
        .expect("B has an identity");
    let ops = ops.iter().collect::<Vec<_>>();
    crate::deferred::retain(b, &identity, None, &ops, &NoFaults).expect("retain");
}

/// A save that continues the conflict's incoming side updates the conflict,
/// so it never waits behind it. A save from another branch does.
#[test]
fn a_continuation_of_the_incoming_side_is_not_a_waiting_version() {
    let (_scratch, mut a, mut b, mut d) = b_holds_a_conflict();
    let landed = format!("{}\nLanded.\n", md(FLOWN));
    let landed_op = a_saves(&mut a, RECORD, RECORD_PATH, &landed, "apollo-landed", 40);
    b_retains(
        &mut b,
        &[from_origin(&landed_op, "device-f", 0)],
        &[&landed],
    );
    assert!(
        waiting(&b).is_empty(),
        "A's next edit continues the conflict"
    );

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
        &[from_origin(&splashed_op, "device-g", 0)],
        &[&splashed],
    );
    assert_eq!(
        waiting(&b),
        vec![(RECORD.to_owned(), "device-g".to_owned(), 0)]
    );
}

/// Retained saves of another file, or of the same file on another version,
/// never wait behind the conflict.
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

/// Only an origin's first retained save can wait behind a conflict. A save
/// for the conflict's file behind other retained work waits on that work.
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

/// A retained row its origin already applied waits for nothing.
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

/// A move from another branch waits too. The waiting version names no path,
/// so a listing words it with the conflict's own path.
#[test]
fn a_move_from_another_branch_waits_under_the_conflicts_path() {
    let (_scratch, _a, mut b, mut d) = b_holds_a_conflict();
    let moved = a_moves_apollo(&mut d);
    pull(&mut b, 3, std::slice::from_ref(&moved), &[]);
    assert!(read_replication_acked_seq(&b, "ws", "device-d").expect("ack") < moved.origin_seq);
    assert_eq!(
        waiting(&b),
        vec![(RECORD.to_owned(), "device-d".to_owned(), moved.origin_seq)]
    );
    assert_eq!(
        count(
            &b,
            "SELECT COUNT(*) FROM conflicts WHERE status='open' AND path='missions/apollo.md'"
        ),
        1
    );
}
