use super::*;
use dohc_engine_collab::ydoc::reading_body_sequence_here;
use dohc_engine_collab::{DocKey, WriterDocCache};

const CANNOT_SETTLE: &str = "ydoc-kept-base-cannot-settle";
const STRAY_ROOTS: &str = "ydoc-update-outside-format-two-roots";
const KEPT: &str = "SELECT COUNT(*) FROM replication_refused_ydoc_blobs";
const NOTICES: &str = "SELECT COUNT(*) FROM replication_pending_refusals";
const QUEUED: &str = "SELECT COUNT(*) FROM ydoc_deferred_updates";
const CHANGES: &str =
    "SELECT COALESCE((SELECT applied FROM remote_changes WHERE workspace_id='ws'), 0)";

struct Note {
    base: Vec<u8>,
    edits: Vec<Vec<u8>>,
    later: Vec<u8>,
    claim: String,
}

fn note() -> Note {
    note_saying("A note.\n")
}

fn note_saying(text: &str) -> Note {
    let newer = dohc_engine_collab::ydoc::format_two_note_for_test(text);
    let edits = vec![
        crate::moment_apply_tests::format_two_sequence_edit(&newer, 7, "y"),
        crate::moment_apply_tests::format_two_sequence_edit(&newer, 8, "z"),
    ];
    let later = crate::moment_apply_tests::format_two_sequence_edit(&newer, 13, "q");
    let base = newer.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    Note {
        base,
        edits,
        later,
        claim,
    }
}

fn stray_note() -> Note {
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, XmlFragment};
    reading_body_sequence_here(|| {
        let newer = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
        let stray = yrs::Doc::with_client_id(7);
        stray
            .transact_mut()
            .apply_update(yrs::Update::decode_v1(&newer.encode_full_state()).expect("decode"))
            .expect("load note");
        let body = stray.get_or_insert_xml_fragment(dohc_engine_collab::ydoc::ROOT_BODY);
        body.insert(
            &mut stray.transact_mut(),
            0,
            yrs::XmlTextPrelim::new("Typed"),
        );
        let base = stray
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        let edits = vec![
            crate::moment_apply_tests::format_two_sequence_edit(&newer, 8, "y"),
            crate::moment_apply_tests::format_two_sequence_edit(&newer, 9, "z"),
        ];
        let later = crate::moment_apply_tests::format_two_sequence_edit(&newer, 13, "q");
        let claim = dohc_engine_storage::hex_sha256(&base);
        Note {
            base,
            edits,
            later,
            claim,
        }
    })
}

fn seed_object(engine: &mut EngineStore, object: &str) -> DocKey {
    seed_object_two(engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', ?1, 1_400)",
                [object],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");
    DocKey::new("ws", "main", object).expect("doc key")
}

fn op(
    engine: &mut EngineStore,
    object: &str,
    at: (&str, i64, i64),
    bytes: &[u8],
    claim: &str,
) -> ReplicationEnvelope {
    let (origin, origin_seq, relay_seq) = at;
    let blob = engine.put_binary_blob(bytes).expect("blob");
    let mut op = envelope(
        origin,
        origin_seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object,
            "path": format!("notes/{object}.md"),
            "contentKind": "richdoc",
            "updateBlobSha256": blob,
            "lineageClaimId": claim,
            "isBaseState": blob == claim
        }),
    );
    op.relay_seq = Some(relay_seq);
    op
}

fn arrive(engine: &mut EngineStore, op: &ReplicationEnvelope) -> ApplyDisposition<YdocApplyResult> {
    apply_ydoc_envelope(
        engine,
        &mut WriterDocCache::new(),
        op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("the op arrives")
    .primary
}

fn refused_as(disposition: &ApplyDisposition<YdocApplyResult>) -> Option<&str> {
    match disposition {
        ApplyDisposition::Refused(refusal) => Some(refusal.reason.message()),
        _ => None,
    }
}

fn keep(
    engine: &mut EngineStore,
    object: &str,
    origin: &str,
    first_relay: i64,
    note: &Note,
) -> DocKey {
    let key = seed_object(engine, object);
    let mut rows = vec![&note.base];
    rows.extend(&note.edits);
    for (seq, bytes) in (0..).zip(rows) {
        let op = op(
            engine,
            object,
            (origin, seq, first_relay + seq),
            bytes,
            &note.claim,
        );
        assert_eq!(refused_as(&arrive(engine, &op)), Some(NEWER_BODY_FORMAT));
    }
    key
}

fn replay_with(
    engine: &mut EngineStore,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<usize, SyncError> {
    reading_body_sequence_here(|| {
        crate::replay_kept_format_two(engine, &mut WriterDocCache::new(), faults)
    })
}

fn replay(engine: &mut EngineStore) -> usize {
    replay_with(engine, &NoFaults).expect("the replay goes on")
}

fn count(engine: &EngineStore, sql: &str) -> i64 {
    engine
        .read_with(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .expect(sql)
}

fn note_text(engine: &EngineStore, key: &DocKey) -> (Option<String>, String) {
    reading_body_sequence_here(|| {
        let persisted = dohc_engine_collab::load_persisted(engine, key)
            .expect("load lineage")
            .expect("persisted lineage");
        let text = persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Richdoc)
            .expect("project")
            .content;
        (persisted.marker.lineage_claim_id, text)
    })
}

fn notices(engine: &EngineStore) -> Vec<(String, i64, String)> {
    engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT origin_id,origin_seq,reason_message FROM replication_pending_refusals \
                 ORDER BY origin_id,origin_seq",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("notices")
}

fn kept_reasons(engine: &EngineStore) -> Vec<(String, i64, Option<String>)> {
    engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT origin_id,origin_seq,reason FROM replication_refused_ydoc_blobs \
                 ORDER BY origin_id,origin_seq",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("kept rows")
}

fn all(reason: &str, origin: &str, seqs: &[i64]) -> Vec<(String, i64, String)> {
    seqs.iter()
        .map(|seq| (origin.to_owned(), *seq, reason.to_owned()))
        .collect()
}

#[test]
fn a_kept_base_and_its_edits_replay_at_open_and_clear_their_notices() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    let key = keep(&mut engine, "object-two", "peer-a", 1, &note);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (3, 3));
    let changes = count(&engine, CHANGES);
    assert_eq!(replay(&mut engine), 3);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (0, 0));
    assert_eq!(count(&engine, CHANGES), changes + 3);
    let (claim, text) = note_text(&engine, &key);
    assert_eq!(claim.as_deref(), Some(note.claim.as_str()));
    assert!(text.contains('y') && text.contains('z'), "{text}");
    assert_eq!(replay(&mut engine), 0);
}

fn applied_edits(engine: &EngineStore, key: &DocKey, note: &Note) -> Vec<String> {
    engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT update_blob_sha256 FROM ydoc_updates WHERE workspace_id=?1 \
                 AND version_id=?2 AND object_id=?3 AND update_blob_sha256<>?4 ORDER BY seq",
            )?
            .query_map(
                (
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                    &note.claim,
                ),
                |row| row.get(0),
            )?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("applied edits")
}

fn edits_in_order(note: &Note) -> Vec<String> {
    note.edits
        .iter()
        .map(|edit| dohc_engine_storage::hex_sha256(edit))
        .collect()
}

#[test]
fn edits_parked_before_their_base_replay_after_it_in_relay_order_and_count_once() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    let key = seed_object(&mut engine, "object-two");
    for (origin, relay, bytes) in [("peer-z", 1, &note.edits[0]), ("peer-a", 2, &note.edits[1])] {
        let edit = op(
            &mut engine,
            "object-two",
            (origin, 0, relay),
            bytes,
            &note.claim,
        );
        assert!(matches!(
            arrive(&mut engine, &edit),
            ApplyDisposition::Applied(result) if result.deferred
        ));
    }
    let base = op(
        &mut engine,
        "object-two",
        ("peer-b", 0, 3),
        &note.base,
        &note.claim,
    );
    assert_eq!(
        refused_as(&arrive(&mut engine, &base)),
        Some(NEWER_BODY_FORMAT)
    );
    assert_eq!(
        (
            count(&engine, KEPT),
            count(&engine, NOTICES),
            count(&engine, QUEUED)
        ),
        (3, 3, 0)
    );
    let changes = count(&engine, CHANGES);
    assert_eq!(replay(&mut engine), 3);
    assert_eq!(applied_edits(&engine, &key, &note), edits_in_order(&note));
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (0, 0));
    assert_eq!(count(&engine, CHANGES), changes + 1);
    let (claim, text) = note_text(&engine, &key);
    assert_eq!(claim.as_deref(), Some(note.claim.as_str()));
    assert!(text.contains('y') && text.contains('z'), "{text}");
}

fn format_one_base() -> (Vec<u8>, String, Vec<u8>) {
    let older = dohc_engine_collab::Ydoc::wire();
    older
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "Other.\n")
        .expect("format-1 note");
    let base = older.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let local = older.richdoc_append_paragraph("Local");
    (base, claim, local)
}

fn edit_locally(engine: &mut EngineStore, key: &DocKey, local: &[u8]) {
    dohc_engine_collab::record_local_update(
        engine,
        &mut WriterDocCache::new(),
        key,
        local,
        dohc_engine_collab::LocalAppend::default(),
        &NoFaults,
        3_000,
        |_, _, _| Ok(()),
    )
    .expect("a local edit");
}

fn open_conflicts_holding(engine: &EngineStore, text: &str) -> i64 {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM conflicts c WHERE c.status='open' AND EXISTS( \
                   SELECT 1 FROM blobs b WHERE b.sha256 IN (c.current_blob_sha256,c.incoming_blob_sha256) \
                   AND instr(b.text, ?1) > 0)",
                [text],
                |row| row.get(0),
            )
        })
        .expect("conflicts")
}

#[test]
fn a_replayed_format_two_base_meets_a_format_one_base_as_an_always_reading_engine_would() {
    let note = note();
    let (older_base, older_claim, local) = format_one_base();
    let (_lower_scratch, _lower_path, mut lower) = open_store();
    let key = seed_object(&mut lower, "object-two");
    let newer = op(
        &mut lower,
        "object-two",
        ("peer-a", 0, 1),
        &note.base,
        &note.claim,
    );
    assert_eq!(
        refused_as(&arrive(&mut lower, &newer)),
        Some(NEWER_BODY_FORMAT)
    );
    let edit = op(
        &mut lower,
        "object-two",
        ("peer-a", 1, 2),
        &note.edits[0],
        &note.claim,
    );
    assert_eq!(
        refused_as(&arrive(&mut lower, &edit)),
        Some(NEWER_BODY_FORMAT)
    );
    let other = op(
        &mut lower,
        "object-two",
        ("peer-b", 0, 3),
        &older_base,
        &older_claim,
    );
    assert!(matches!(
        arrive(&mut lower, &other),
        ApplyDisposition::Applied(_)
    ));
    edit_locally(&mut lower, &key, &local);
    assert_eq!(replay(&mut lower), 2);
    let (claim, text) = note_text(&lower, &key);
    assert_eq!(
        claim.as_deref(),
        Some(note.claim.as_str()),
        "the lower position wins"
    );
    assert!(text.contains('y'), "the format-2 edit lands: {text}");
    assert!(
        open_conflicts_holding(&lower, "Local") >= 1,
        "the format-1 side and its local edit stay as an open conflict"
    );
    assert_eq!(count(&lower, KEPT), 0);

    let run = |reading_first: bool| {
        let (_scratch, _path, mut engine) = open_store();
        let key = seed_object(&mut engine, "object-two");
        let other = op(
            &mut engine,
            "object-two",
            ("peer-b", 0, 1),
            &older_base,
            &older_claim,
        );
        assert!(matches!(
            arrive(&mut engine, &other),
            ApplyDisposition::Applied(_)
        ));
        edit_locally(&mut engine, &key, &local);
        let newer = op(
            &mut engine,
            "object-two",
            ("peer-a", 0, 2),
            &note.base,
            &note.claim,
        );
        let edit = op(
            &mut engine,
            "object-two",
            ("peer-a", 1, 3),
            &note.edits[0],
            &note.claim,
        );
        if reading_first {
            reading_body_sequence_here(|| {
                arrive(&mut engine, &newer);
                arrive(&mut engine, &edit);
            });
        } else {
            arrive(&mut engine, &newer);
            arrive(&mut engine, &edit);
            replay(&mut engine);
        }
        let (claim, text) = note_text(&engine, &key);
        let conflicts = count(
            &engine,
            "SELECT COUNT(*) FROM conflicts WHERE status='open'",
        );
        (
            claim,
            text,
            conflicts,
            count(&engine, KEPT),
            notices(&engine),
        )
    };
    let always = run(true);
    assert_eq!(always.0.as_deref(), Some(older_claim.as_str()));
    assert!(always.1.contains("Local"), "{}", always.1);
    assert_eq!(
        run(false),
        always,
        "the higher position matches an always-reading engine"
    );
}

#[test]
fn a_stray_roots_base_refuses_its_whole_claim_in_one_step_and_the_next_note_replays() {
    let stray = stray_note();
    let good = note();
    for crash_after in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        let stray_key = keep(&mut engine, "object-two", "peer-a", 1, &stray);
        let good_key = keep(&mut engine, "object-three", "peer-b", 10, &good);
        let later = reading_body_sequence_here(|| {
            let later = op(
                &mut engine,
                "object-two",
                ("peer-a", 3, 20),
                &stray.later,
                &stray.claim,
            );
            arrive(&mut engine, &later)
        });
        assert!(
            matches!(&later, ApplyDisposition::Applied(result) if result.deferred),
            "{later:?}"
        );
        if crash_after {
            let crash = super::super::ordinary_pull_progress::CrashAt {
                point: dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck,
                nth: 0,
                seen: std::sync::atomic::AtomicUsize::new(0),
            };
            let _ = replay_with(&mut engine, &crash);
            assert_eq!(count(&engine, KEPT), 6, "nothing is lost after the refusal");
        }
        replay(&mut engine);
        assert_eq!(notices(&engine), all(STRAY_ROOTS, "peer-a", &[0, 1, 2, 3]));
        assert_eq!(count(&engine, QUEUED), 0);
        assert_eq!(
            kept_reasons(&engine),
            all(STRAY_ROOTS, "peer-a", &[0, 1, 2])
                .into_iter()
                .map(|(origin, seq, reason)| (origin, seq, Some(reason)))
                .collect::<Vec<_>>()
        );
        assert!(
            dohc_engine_collab::read_marker(&engine, &stray_key)
                .expect("marker")
                .is_none_or(
                    |marker| marker.lineage_claim_id.as_deref() != Some(stray.claim.as_str())
                )
        );
        let (claim, text) = note_text(&engine, &good_key);
        assert_eq!(claim.as_deref(), Some(good.claim.as_str()));
        assert!(text.contains('y') && text.contains('z'), "{text}");
        assert_eq!(replay(&mut engine), 0);
        assert_eq!(notices(&engine).len(), 4);
    }
}

fn kept_with_a_queued_edit(note: &Note) -> (ScratchDir, std::path::PathBuf, EngineStore, DocKey) {
    let (scratch, path, mut engine) = open_store();
    let key = seed_object(&mut engine, "object-two");
    for (seq, bytes) in [(0, &note.base), (1, &note.edits[0])] {
        let op = op(
            &mut engine,
            "object-two",
            ("peer-a", seq, seq + 1),
            bytes,
            &note.claim,
        );
        assert_eq!(
            refused_as(&arrive(&mut engine, &op)),
            Some(NEWER_BODY_FORMAT)
        );
    }
    let queued = op(
        &mut engine,
        "object-two",
        ("peer-a", 2, 3),
        &note.edits[1],
        &note.claim,
    );
    assert!(matches!(
        reading_body_sequence_here(|| arrive(&mut engine, &queued)),
        ApplyDisposition::Applied(result) if result.deferred
    ));
    (scratch, path, engine, key)
}

fn crash_at(
    point: dohc_engine_storage::FaultPoint,
    nth: usize,
) -> super::super::ordinary_pull_progress::CrashAt {
    super::super::ordinary_pull_progress::CrashAt {
        point,
        nth,
        seen: std::sync::atomic::AtomicUsize::new(0),
    }
}

#[test]
fn a_crash_at_each_replay_commit_converges_in_order_without_doubling() {
    use std::sync::atomic::Ordering;
    let note = note();
    for point in [
        dohc_engine_storage::FaultPoint::StorageBeforePersist,
        dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (_scratch, _path, mut engine, _key) = kept_with_a_queued_edit(&note);
        let commits = crash_at(point, usize::MAX);
        replay_with(&mut engine, &commits).expect("the replay goes on");
        let commits = commits.seen.load(Ordering::SeqCst);
        assert!(commits >= 4, "{point:?}: {commits} commits");
        let mut left = Vec::new();
        for nth in 0..commits {
            let (_scratch, path, mut engine, key) = kept_with_a_queued_edit(&note);
            let changes = count(&engine, CHANGES);
            let crash = crash_at(point, nth);
            let _ = replay_with(&mut engine, &crash);
            assert!(crash.seen.load(Ordering::SeqCst) > nth, "{point:?} #{nth}");
            left.push((
                count(
                    &engine,
                    "SELECT COALESCE(SUM(replayed), 0) FROM replication_refused_ydoc_blobs",
                ),
                count(&engine, KEPT),
                count(&engine, QUEUED),
            ));
            drop(engine);
            let mut engine = EngineStore::open(&path, 1_000).expect("reopen");
            replay_with(&mut engine, &NoFaults)
                .unwrap_or_else(|error| panic!("{point:?} #{nth}: {error:?}"));
            assert_eq!(
                applied_edits(&engine, &key, &note),
                edits_in_order(&note),
                "{point:?} #{nth}"
            );
            assert_eq!(
                (
                    count(&engine, KEPT),
                    count(&engine, NOTICES),
                    count(&engine, QUEUED),
                    count(&engine, CHANGES)
                ),
                (0, 0, 0, changes + 3),
                "{point:?} #{nth}"
            );
            let (claim, text) = note_text(&engine, &key);
            assert_eq!(
                claim.as_deref(),
                Some(note.claim.as_str()),
                "{point:?} #{nth}"
            );
            assert_eq!(
                (text.matches('y').count(), text.matches('z').count()),
                (1, 1),
                "{point:?} #{nth}: {text}"
            );
        }
        let (at_the_kept_edit, at_the_final_delete) =
            if point == dohc_engine_storage::FaultPoint::StorageBeforePersist {
                ((1, 2, 1), (2, 2, 0))
            } else {
                ((2, 2, 1), (0, 0, 0))
            };
        assert!(left.contains(&at_the_kept_edit), "{point:?}: {left:?}");
        assert_eq!(left.last(), Some(&at_the_final_delete), "{point:?}");
    }
}

#[test]
fn the_same_note_arriving_first_from_another_origin_replays_without_doubling() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    let key = keep(&mut engine, "object-two", "peer-a", 1, &note);
    reading_body_sequence_here(|| {
        for (seq, bytes) in [(0, &note.base), (1, &note.edits[0])] {
            let op = op(
                &mut engine,
                "object-two",
                ("peer-c", seq, 10 + seq),
                bytes,
                &note.claim,
            );
            assert!(matches!(
                arrive(&mut engine, &op),
                ApplyDisposition::Applied(_)
            ));
        }
    });
    replay(&mut engine);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (0, 0));
    let (claim, text) = note_text(&engine, &key);
    assert_eq!(claim.as_deref(), Some(note.claim.as_str()));
    assert_eq!(
        (text.matches('y').count(), text.matches('z').count()),
        (1, 1),
        "{text}"
    );
}

#[test]
fn with_the_switch_off_nothing_replays_and_a_pull_answers_redelivered() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    keep(&mut engine, "object-two", "peer-a", 1, &note);
    assert_eq!(
        crate::replay_kept_format_two(&mut engine, &mut WriterDocCache::new(), &NoFaults)
            .expect("the replay goes on"),
        0
    );
    let again = op(
        &mut engine,
        "object-two",
        ("peer-a", 0, 1),
        &note.base,
        &note.claim,
    );
    assert!(matches!(
        arrive(&mut engine, &again),
        ApplyDisposition::Skipped
    ));
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (3, 3));
}

#[test]
fn a_dismissed_notice_still_replays() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    let key = keep(&mut engine, "object-two", "peer-a", 1, &note);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM replication_pending_refusals", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("dismiss");
    assert_eq!(replay(&mut engine), 3);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (0, 0));
    let (_, text) = note_text(&engine, &key);
    assert!(text.contains('y') && text.contains('z'), "{text}");
}

#[test]
fn a_kept_base_that_collides_with_the_installed_base_settles_as_refused() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    let (older_base, older_claim, _local) = format_one_base();
    let key = seed_object(&mut engine, "object-two");
    let newer = op(
        &mut engine,
        "object-two",
        ("peer-a", 0, 5),
        &note.base,
        &note.claim,
    );
    assert_eq!(
        refused_as(&arrive(&mut engine, &newer)),
        Some(NEWER_BODY_FORMAT)
    );
    let edit = op(
        &mut engine,
        "object-two",
        ("peer-a", 1, 6),
        &note.edits[0],
        &note.claim,
    );
    assert_eq!(
        refused_as(&arrive(&mut engine, &edit)),
        Some(NEWER_BODY_FORMAT)
    );
    let other = op(
        &mut engine,
        "object-two",
        ("peer-b", 0, 5),
        &older_base,
        &older_claim,
    );
    assert!(matches!(
        arrive(&mut engine, &other),
        ApplyDisposition::Applied(_)
    ));
    replay(&mut engine);
    assert_eq!(notices(&engine), all(CANNOT_SETTLE, "peer-a", &[0, 1]));
    assert_eq!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("marker")
            .and_then(|marker| marker.lineage_claim_id),
        Some(older_claim)
    );
    assert_eq!(replay(&mut engine), 0);
    assert_eq!(notices(&engine), all(CANNOT_SETTLE, "peer-a", &[0, 1]));
}

#[test]
fn rows_kept_before_this_build_from_another_epoch_or_for_a_live_session_never_replay() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    keep(&mut engine, "object-two", "peer-a", 1, &note);
    assert_eq!(replay(&mut engine), 3, "a current row replays");
    keep(&mut engine, "object-three", "peer-b", 10, &note);
    keep(&mut engine, "object-four", "peer-c", 20, &note);
    keep(&mut engine, "object-five", "peer-d", 30, &note);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(&format!(
                "UPDATE replication_refused_ydoc_blobs SET reason=NULL WHERE origin_id='peer-b';
                 UPDATE replication_refused_ydoc_blobs SET replication_epoch='an-older-epoch' \
                   WHERE origin_id='peer-c';
                 UPDATE replication_refused_ydoc_blobs SET reason='{}' WHERE origin_id='peer-d';",
                crate::ydoc_apply::LIVE_UNADMITTED_UPDATE
            ))
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("age the rows");
    assert_eq!(replay(&mut engine), 0);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (9, 9));
}

#[test]
fn a_later_edit_for_a_claim_refused_on_replay_is_refused_for_the_same_reason_and_not_parked() {
    let (_scratch, _path, mut engine) = open_store();
    let stray = stray_note();
    keep(&mut engine, "object-two", "peer-a", 1, &stray);
    replay(&mut engine);
    assert_eq!(notices(&engine), all(STRAY_ROOTS, "peer-a", &[0, 1, 2]));
    let later = reading_body_sequence_here(|| {
        let later = op(
            &mut engine,
            "object-two",
            ("peer-e", 0, 30),
            &stray.later,
            &stray.claim,
        );
        arrive(&mut engine, &later)
    });
    assert_eq!(refused_as(&later), Some(STRAY_ROOTS));
    assert_eq!(count(&engine, QUEUED), 0);
}

#[test]
fn a_kept_coordinate_replays_only_with_its_own_payload() {
    let (_scratch, _path, mut engine) = open_store();
    let note = note();
    keep(&mut engine, "object-two", "peer-a", 1, &note);
    let mut changed = op(
        &mut engine,
        "object-two",
        ("peer-a", 0, 1),
        &note.base,
        &note.claim,
    );
    changed.payload["path"] = json!("notes/elsewhere.md");
    let same = op(
        &mut engine,
        "object-two",
        ("peer-a", 0, 1),
        &note.base,
        &note.claim,
    );
    let replaying = |engine: &mut EngineStore, op: &ReplicationEnvelope| {
        reading_body_sequence_here(|| {
            crate::kept_replay::replaying(|| {
                apply_ydoc_envelope(
                    engine,
                    &mut WriterDocCache::new(),
                    op,
                    &NoFaults,
                    &NoLiveLeases,
                )
            })
        })
    };
    assert!(matches!(
        replaying(&mut engine, &changed),
        Err(SyncError::CoordinateDiverged)
    ));
    assert!(matches!(
        replaying(&mut engine, &same).expect("replays").primary,
        ApplyDisposition::Applied(_)
    ));
}

#[test]
fn a_thousand_kept_format_two_ops_replay_in_one_open() {
    let (_scratch, _path, mut engine) = open_store();
    for i in 0..250 {
        let mut note = note_saying(&format!("Note {i}.\n"));
        note.edits.push(note.later.clone());
        keep(
            &mut engine,
            &format!("bulk-{i}"),
            &format!("peer-{i}"),
            1 + 4 * i,
            &note,
        );
    }
    assert_eq!(count(&engine, KEPT), 1_000);
    assert_eq!(replay(&mut engine), 1_000);
    assert_eq!((count(&engine, KEPT), count(&engine, NOTICES)), (0, 0));
}
