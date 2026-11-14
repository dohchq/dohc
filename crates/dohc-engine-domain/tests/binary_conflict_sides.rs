use dohc_engine_domain::conflicts::hydrate_binary_conflict_blob;
use dohc_engine_domain::{
    BINARY_COMBINED_TEXT_REFUSAL, ConflictChoice, ConflictContentKind, ConflictFileState,
    ConflictMetadata, ConflictStatus, DomainError, EngineStore, NoFaults, ResolveConflictKind,
    ResolveTextConflict, TextConflict, TextSnapshot, VersionedTextStore, WriteBinaryFile,
    WriteText, insert_text_conflict_if_absent, load_text_conflict_in_tx, write_binary_file_in_tx,
};
use dohc_engine_storage::blob::{binary_blob_count, get_binary_blob};
use dohc_engine_storage::{
    MAX_BLOB_BYTES, Preimage, StorageError, has_binary_blob, hex_sha256, put_binary_blob,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;

const WS: &str = "probe-ws";

/// Assert the exact `InvalidInput` reason, not just the shared code — an
/// unrelated validation failure must not satisfy a binary-gate probe.
#[track_caller]
fn assert_invalid_input(err: &DomainError, expected_reason: &str) {
    match err {
        DomainError::InvalidInput { reason } => assert_eq!(*reason, expected_reason),
        other => panic!("expected InvalidInput({expected_reason:?}), got {other:?}"),
    }
}

#[track_caller]
fn assert_combined_text_refused(err: &DomainError) {
    assert_invalid_input(err, BINARY_COMBINED_TEXT_REFUSAL);
}

fn open_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch dir");
    let path = engine_db_path(&scratch).expect("db path");
    let mut store = dohc_engine_testkit::open_empty_store(&path, 1_000);
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1_000, &NoFaults)
        .expect("workspace");
    (scratch, store)
}

fn write_file(store: &mut EngineStore, path: &str, text: &str) -> TextSnapshot {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("object-{path}"),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("moment-{path}"),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write text")
        .snapshot
}

fn conflict(
    id: &str,
    path: &str,
    base: ConflictFileState,
    current: ConflictFileState,
    incoming: ConflictFileState,
) -> TextConflict {
    TextConflict {
        conflict_id: id.to_owned(),
        workspace_id: WS.to_owned(),
        path: path.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feature".to_owned(),
        created_at_ms: 2_000,
        updated_at_ms: 2_000,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("merge"),
        base,
        current,
        incoming,
    }
}

fn resolve_input(id: &str, kind: ResolveConflictKind) -> ResolveTextConflict {
    ResolveTextConflict {
        workspace_id: WS.to_owned(),
        conflict_id: id.to_owned(),
        resolution: kind,
        object_id: format!("resolve-object-{id}"),
        write_moment_id: format!("resolve-write-{id}"),
        delete_moment_id: format!("resolve-delete-{id}"),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 3_000,
        request_id: None,
        // This caller builds no wire answer, so nothing bounds the row here.
        conflict_answer_budget_bytes: usize::MAX,
    }
}

fn write_binary_head(store: &mut EngineStore, object_id: &str, path: &str, bytes: &[u8]) -> String {
    let sha = hex_sha256(bytes);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob(tx, bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: object_id.to_owned(),
                    path: path.to_owned(),
                    binary_sha256: sha.clone(),
                    moment_id: format!("binjob-{object_id}"),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Absent),
                    now_ms: 2_500,
                },
            )
        })
        .expect("write binary head");
    sha
}

fn hydrate(store: &mut EngineStore, bytes: &[u8]) -> String {
    let sha = hex_sha256(bytes);
    let claimed = sha.clone();
    let bytes = bytes.to_vec();
    store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, &claimed, &bytes)
        })
        .expect("hydrate blob");
    sha
}

fn incoming_text_snapshot(path: &str, text: &str) -> TextSnapshot {
    TextSnapshot {
        workspace_id: WS.to_owned(),
        version_id: "feature".to_owned(),
        object_id: format!("incoming-object-{path}"),
        path: path.to_owned(),
        text: text.to_owned(),
        blob_sha256: hex_sha256(text.as_bytes()),
        updated_at_ms: 1_900,
        latest_moment_id: format!("incoming-moment-{path}"),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
    }
}

#[test]
fn keep_current_on_binary_incoming_keeps_the_live_head() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "mixed.dat", "current text");
    let sha = hydrate(&mut store, b"incoming binary payload");
    let c = conflict(
        "kc-binary-incoming",
        "mixed.dat",
        ConflictFileState::text("mixed.dat", None),
        ConflictFileState::text("mixed.dat", Some(current)),
        ConflictFileState::binary("mixed.dat", sha),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open mixed conflict");

    let result = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("kc-binary-incoming", ResolveConflictKind::KeepCurrent),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("keeping the current side never touches the incoming bytes");
    assert_eq!(result.conflict.status, ConflictStatus::Resolved);
    assert_eq!(result.conflict.chosen_from, ConflictChoice::Current);
    assert!(result.write.is_some() && result.delete.is_none() && result.binary_write.is_none());
    assert_eq!(
        VersionedTextStore::new(&mut store)
            .read_text(WS, "main", "mixed.dat")
            .expect("read the live head")
            .expect("the head is still text")
            .text,
        "current text"
    );
}

#[test]
fn apply_incoming_over_a_binary_base_writes_the_incoming_text() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "based.dat", "current text");
    let sha = hydrate(&mut store, b"binary base payload");
    let c = conflict(
        "ai-binary-base",
        "based.dat",
        ConflictFileState::binary("based.dat", sha),
        ConflictFileState::text("based.dat", Some(current)),
        ConflictFileState::text(
            "based.dat",
            Some(incoming_text_snapshot("based.dat", "incoming text")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open binary-base conflict");

    let result = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("ai-binary-base", ResolveConflictKind::ApplyIncoming),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("a binary base does not block a text-to-text resolution");
    assert_eq!(
        result
            .write
            .expect("the incoming text is written")
            .snapshot
            .text,
        "incoming text"
    );
    assert!(result.binary_write.is_none());
}

/// The review panel renders a binary-BASE conflict as text -- two readable
/// panes and a "combine by hand" action -- because both live sides are text.
/// Combined text must therefore resolve it. A guard keyed on the base would
/// put a guaranteed refusal behind a rendered button.
///
#[test]
fn apply_merged_over_a_binary_base_writes_the_combined_text() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "combined.dat", "current text");
    let sha = hydrate(&mut store, b"binary base for combine");
    let c = conflict(
        "am-binary-base",
        "combined.dat",
        ConflictFileState::binary("combined.dat", sha),
        ConflictFileState::text("combined.dat", Some(current)),
        ConflictFileState::text(
            "combined.dat",
            Some(incoming_text_snapshot("combined.dat", "incoming text")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open binary-base conflict");

    let result = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input(
                "am-binary-base",
                ResolveConflictKind::ApplyMerged {
                    text: "combined by hand".to_owned(),
                },
            ),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("a binary base does not block combining two texts");
    assert_eq!(result.conflict.chosen_from, ConflictChoice::Merged);
    assert_eq!(
        result
            .write
            .expect("the combined text is written")
            .snapshot
            .text,
        "combined by hand"
    );
    assert!(result.binary_write.is_none());
}

#[test]
fn keep_current_with_binary_base_writes_the_kept_text() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "kcbase.dat", "current text");
    let sha = hydrate(&mut store, b"binary base for keep-current");
    let c = conflict(
        "kc-binary-base",
        "kcbase.dat",
        ConflictFileState::binary("kcbase.dat", sha),
        ConflictFileState::text("kcbase.dat", Some(current)),
        ConflictFileState::text("kcbase.dat", None),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open conflict");

    let result = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("kc-binary-base", ResolveConflictKind::KeepCurrent),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("a binary base does not block keeping the current side");
    assert_eq!(result.conflict.chosen_from, ConflictChoice::Current);
    assert!(result.write.is_some() && result.delete.is_none() && result.binary_write.is_none());
}

#[test]
fn apply_merged_with_binary_side_fails_closed() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "merged.dat", "current text");
    let sha = hydrate(&mut store, b"binary incoming for merged");
    let c = conflict(
        "am-binary",
        "merged.dat",
        ConflictFileState::text("merged.dat", None),
        ConflictFileState::text("merged.dat", Some(current)),
        ConflictFileState::binary("merged.dat", sha),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open conflict");

    let err = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input(
                "am-binary",
                ResolveConflictKind::ApplyMerged {
                    text: "merged".to_owned(),
                },
            ),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect_err("ApplyMerged must reject binary sides");
    assert_combined_text_refused(&err);
}

/// A conflict whose recorded current side no longer describes the live head
/// must fail closed on every resolve path. Nothing was ever written at
/// `asset.bin`, so this all-binary row is stale on arrival — except for
/// combined text, which bytes refuse before the head is ever measured.
#[test]
fn all_binary_resolve_over_an_absent_live_head_fails_closed() {
    let (_scratch, mut store) = open_store();
    let base = hydrate(&mut store, b"bin base");
    let cur = hydrate(&mut store, b"bin current");
    let inc = hydrate(&mut store, b"bin incoming");
    let c = conflict(
        "all-binary",
        "asset.bin",
        ConflictFileState::binary("asset.bin", base),
        ConflictFileState::binary("asset.bin", cur),
        ConflictFileState::binary("asset.bin", inc),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open all-binary conflict");

    for (label, kind) in [
        ("keep-current", ResolveConflictKind::KeepCurrent),
        ("apply-incoming", ResolveConflictKind::ApplyIncoming),
    ] {
        let err = VersionedTextStore::new(&mut store)
            .resolve_text_conflict_with(
                &resolve_input("all-binary", kind),
                &NoFaults,
                |_, _, _| Ok(()),
                |_, _, ()| Ok(()),
            )
            .expect_err("a stale all-binary resolve must fail closed");
        assert!(
            matches!(&err, DomainError::ConflictStaleTarget),
            "{label}: expected a stale-target refusal, got {err:?}",
        );
    }
    let err = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input(
                "all-binary",
                ResolveConflictKind::ApplyMerged {
                    text: "m".to_owned(),
                },
            ),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect_err("combined text must never resolve bytes");
    assert_combined_text_refused(&err);
}

#[test]
fn binary_sha_only_in_text_blobs_table_is_rejected() {
    let (_scratch, mut store) = open_store();
    let bytes = b"impostor payload";
    let sha = hex_sha256(bytes);
    let sha_for_insert = sha.clone();
    store
        .write_with(&NoFaults, move |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                params![sha_for_insert, bytes.len() as i64, "impostor payload"],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed text blob");
    let c = conflict(
        "wrong-table",
        "imp.bin",
        ConflictFileState::text("imp.bin", None),
        ConflictFileState::text("imp.bin", None),
        ConflictFileState::binary("imp.bin", sha),
    );
    let err = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect_err("sha present only in text blobs must be rejected");
    assert_invalid_input(
        &err,
        "binary conflict side references a missing binary blob",
    );
}

#[test]
fn empty_binary_sha_is_rejected() {
    let (_scratch, mut store) = open_store();
    let c = conflict(
        "empty-sha",
        "e.bin",
        ConflictFileState::text("e.bin", None),
        ConflictFileState::text("e.bin", None),
        ConflictFileState::binary("e.bin", ""),
    );
    let err = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect_err("empty sha must be rejected");
    assert_invalid_input(
        &err,
        "binary conflict side references a missing binary blob",
    );
}

#[test]
fn hydrate_mismatch_leaves_no_row() {
    let (_scratch, mut store) = open_store();
    let claimed = hex_sha256(b"what I claim");
    let claimed_probe = claimed.clone();
    let err = store
        .write_with(&NoFaults, {
            let claimed = claimed.clone();
            move |tx| hydrate_binary_conflict_blob(tx, &claimed, b"what I actually send")
        })
        .expect_err("mismatch must fail closed");
    assert_eq!(err.code(), "blob-integrity");
    let (present_claimed, present_actual, count) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                has_binary_blob(conn, &claimed_probe)?,
                has_binary_blob(conn, &hex_sha256(b"what I actually send"))?,
                binary_blob_count(conn)?,
            ))
        })
        .expect("probe rows");
    assert!(!present_claimed, "mislabeled blob stored under claimed sha");
    assert!(!present_actual, "rejected bytes were stored anyway");
    assert_eq!(count, 0, "no rows may survive a rejected hydrate");
}

#[test]
fn hydrate_idempotent_and_claim_canonicalized() {
    let (_scratch, mut store) = open_store();
    let bytes = b"stable payload";
    let sha = hydrate(&mut store, bytes);
    let sha2 = hydrate(&mut store, bytes);
    assert_eq!(sha, sha2);
    let count = store
        .read_with(binary_blob_count)
        .expect("count after double hydrate");
    assert_eq!(count, 1, "double hydrate must dedup to one row");

    let upper = sha.to_uppercase();
    let dohc_engine_domain::TxnOutcome::Committed(returned) = store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, &upper, b"stable payload")
        })
        .expect("uppercase claim of correct bytes must be accepted")
    else {
        panic!("uppercase hydrate must commit");
    };
    assert_eq!(returned, sha, "key must canonicalize to lowercase");
    let count = store
        .read_with(binary_blob_count)
        .expect("count after uppercase hydrate");
    assert_eq!(count, 1, "uppercase claim must dedup to the canonical row");

    let err = store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, "abc123", b"stable payload")
        })
        .expect_err("wrong-length claim must be rejected");
    assert_eq!(err.code(), "blob-integrity");

    let fetched = store
        .read_with(|conn| get_binary_blob(conn, &sha))
        .expect("get blob")
        .expect("blob row");
    assert_eq!(fetched, bytes);
}

#[test]
fn hydrate_size_bounds() {
    let (_scratch, mut store) = open_store();
    let empty_sha = hex_sha256(b"");
    let empty_claim = empty_sha.clone();
    store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, &empty_claim, b"")
        })
        .expect("empty bytes must hydrate");
    assert!(
        store
            .read_with(|conn| has_binary_blob(conn, &empty_sha))
            .expect("probe")
    );

    let huge = vec![0u8; MAX_BLOB_BYTES + 1];
    let huge_sha = hex_sha256(&huge);
    let err = store
        .write_with(&NoFaults, {
            let huge = huge.clone();
            move |tx| hydrate_binary_conflict_blob(tx, &huge_sha, &huge)
        })
        .expect_err("over-cap bytes must be rejected");
    assert_eq!(err.code(), "blob-too-large");

    let wrong_claim = hex_sha256(b"not the huge bytes");
    let err = store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, &wrong_claim, &huge)
        })
        .expect_err("over-cap bytes with a wrong claim must be rejected on size");
    assert_eq!(err.code(), "blob-too-large");
}

#[test]
fn hydrate_fails_closed_when_existing_row_is_corrupt() {
    let (_scratch, mut store) = open_store();
    let bytes = b"original bytes";
    let sha = hydrate(&mut store, bytes);
    let sha_corrupt = sha.clone();
    store
        .write_with(&NoFaults, move |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes = ?2, byte_length = ?3 WHERE sha256 = ?1",
                params![sha_corrupt, b"rotted".as_slice(), 6_i64],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("corrupt row");
    let sha_for_rehydrate = sha.clone();
    let bytes_for_rehydrate = bytes.to_vec();
    let err = store
        .write_with(&NoFaults, move |tx| {
            hydrate_binary_conflict_blob(tx, &sha_for_rehydrate, &bytes_for_rehydrate)
        })
        .expect_err("re-hydrate over a corrupt canonical row must fail closed");
    assert_eq!(err.code(), "blob-integrity");
    // The corrupt row is left as evidence (no silent repair/overwrite), and
    // the read path fails closed on it too.
    let err = store
        .read_with(|conn| get_binary_blob(conn, &sha))
        .expect_err("corrupt row must fail closed on read");
    assert_eq!(err.code(), "blob-integrity");
}

#[test]
fn absent_text_side_with_blob_reference_fails_closed_on_read() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "ghost.md", "current body");
    let current_blob = current.blob_sha256.clone();
    let c = conflict(
        "ghost",
        "ghost.md",
        ConflictFileState::text("ghost.md", None),
        ConflictFileState::text("ghost.md", Some(current)),
        ConflictFileState::text(
            "ghost.md",
            Some(incoming_text_snapshot("ghost.md", "incoming body")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open text conflict");
    // Corrupt the row: the absent base side gains a dangling text-blob
    // reference (pointing at a real blobs row so the FK holds).
    store
        .write_with(&NoFaults, move |tx| {
            tx.execute(
                "UPDATE conflicts SET base_blob_sha256 = ?1 \
                 WHERE workspace_id = ?2 AND conflict_id = 'ghost'",
                params![current_blob, WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("inject stray text-blob reference");
    let err = store
        .read_with(|conn| load_text_conflict_in_tx(conn, WS, "ghost"))
        .expect_err("absent side with a blob reference must fail closed");
    assert_eq!(err.code(), "state-corrupt");
}

/// The stale-head gate must not treat two absent text states at different
/// paths as the same state: a replicated open records per-side paths, so a
/// divergent recorded current path must fail the match even when both
/// snapshots are absent.
#[test]
fn absent_states_at_different_paths_do_not_match() {
    use dohc_engine_domain::live_state_matches_conflict_current;
    let live = ConflictFileState::text("a.md", None);
    let same = ConflictFileState::text("a.md", None);
    let divergent = ConflictFileState::text("b.md", None);
    assert!(live_state_matches_conflict_current(&live, &same));
    assert!(!live_state_matches_conflict_current(&live, &divergent));
}

#[test]
fn text_side_with_stray_binary_column_fails_closed_on_read() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "doc.md", "hello");
    let sha = hydrate(&mut store, b"stray binary");
    let c = conflict(
        "stray",
        "doc.md",
        ConflictFileState::text("doc.md", None),
        ConflictFileState::text("doc.md", Some(current)),
        ConflictFileState::text("doc.md", Some(incoming_text_snapshot("doc.md", "incoming"))),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open text conflict");
    let sha_set = sha.clone();
    store
        .write_with(&NoFaults, move |tx| {
            tx.execute(
                "UPDATE conflicts SET incoming_binary_sha256 = ?1 \
                 WHERE workspace_id = ?2 AND conflict_id = 'stray'",
                params![sha_set, WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("inject stray binary reference");
    let err = store
        .read_with(|conn| load_text_conflict_in_tx(conn, WS, "stray"))
        .expect_err("mixed columns must fail closed");
    assert_eq!(err.code(), "state-corrupt");
}

/// Plain text conflict open -> resolve ApplyIncoming still works end to end
/// (no regression from the schema change or the any-side-binary gate).
#[test]
fn text_conflict_round_trip_unchanged() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "note.md", "current body");
    let c = conflict(
        "text-rt",
        "note.md",
        ConflictFileState::text("note.md", None),
        ConflictFileState::text("note.md", Some(current)),
        ConflictFileState::text(
            "note.md",
            Some(incoming_text_snapshot("note.md", "incoming body")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open text conflict");
    let result = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("text-rt", ResolveConflictKind::ApplyIncoming),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("text resolve must still work");
    assert_eq!(result.conflict.status, ConflictStatus::Resolved);
    assert!(result.write.is_some());
    let live = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "note.md")
        .expect("read")
        .expect("snapshot");
    assert_eq!(live.text, "incoming body");

    let loaded = store
        .read_with(|conn| load_text_conflict_in_tx(conn, WS, "text-rt"))
        .expect("load")
        .expect("row");
    assert_eq!(loaded.incoming.content_kind, ConflictContentKind::Text);
    assert!(loaded.incoming.binary_sha256.is_none());
}

#[test]
fn binary_current_over_an_absent_live_head_blocks_resolve() {
    let (_scratch, mut store) = open_store();
    let sha = hydrate(&mut store, b"binary current bytes");
    let c = conflict(
        "bin-current",
        "cur.bin",
        ConflictFileState::text("cur.bin", None),
        ConflictFileState::binary("cur.bin", sha),
        ConflictFileState::text(
            "cur.bin",
            Some(incoming_text_snapshot("cur.bin", "incoming text")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open conflict");
    for kind in [
        ResolveConflictKind::KeepCurrent,
        ResolveConflictKind::ApplyIncoming,
    ] {
        let err = VersionedTextStore::new(&mut store)
            .resolve_text_conflict_with(
                &resolve_input("bin-current", kind),
                &NoFaults,
                |_, _, _| Ok(()),
                |_, _, ()| Ok(()),
            )
            .expect_err("a stale binary current must block resolve");
        assert!(
            matches!(&err, DomainError::ConflictStaleTarget),
            "got {err:?}"
        );
    }
    let err = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input(
                "bin-current",
                ResolveConflictKind::ApplyMerged {
                    text: "m".to_owned(),
                },
            ),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect_err("combined text must never resolve bytes");
    assert_combined_text_refused(&err);
}

#[test]
fn binary_side_with_text_snapshot_rejected() {
    let (_scratch, mut store) = open_store();
    let sha = hydrate(&mut store, b"both worlds");
    let mut side = ConflictFileState::binary("b.bin", sha);
    side.snapshot = Some(incoming_text_snapshot("b.bin", "sneaky text"));
    let c = conflict(
        "both-kinds",
        "b.bin",
        ConflictFileState::text("b.bin", None),
        ConflictFileState::text("b.bin", None),
        side,
    );
    let err = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect_err("binary side with text snapshot must be rejected");
    assert_invalid_input(&err, "binary conflict side cannot carry a text snapshot");
}

#[test]
fn duplicate_conflict_id_with_invalid_binary_side_rejected() {
    let (_scratch, mut store) = open_store();
    let sha = hydrate(&mut store, b"dup payload");
    let valid = conflict(
        "dup",
        "d.bin",
        ConflictFileState::text("d.bin", None),
        ConflictFileState::text("d.bin", None),
        ConflictFileState::binary("d.bin", sha.clone()),
    );
    let inserted = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &valid))
        .expect("open valid binary-side conflict");
    assert_eq!(inserted, dohc_engine_domain::TxnOutcome::Committed(true));

    let duplicate = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &valid))
        .expect("honest duplicate stays idempotent");
    assert_eq!(duplicate, dohc_engine_domain::TxnOutcome::Committed(false));

    let unhydrated = conflict(
        "dup",
        "d.bin",
        ConflictFileState::text("d.bin", None),
        ConflictFileState::text("d.bin", None),
        ConflictFileState::binary("d.bin", hex_sha256(b"never hydrated")),
    );
    let err = store
        .write_with(&NoFaults, |tx| {
            insert_text_conflict_if_absent(tx, &unhydrated)
        })
        .expect_err("unhydrated binary side on duplicate id must be rejected");
    assert_invalid_input(
        &err,
        "binary conflict side references a missing binary blob",
    );

    let mut missing_side = ConflictFileState::text("d.bin", None);
    missing_side.content_kind = ConflictContentKind::Binary;
    let missing = conflict(
        "dup",
        "d.bin",
        ConflictFileState::text("d.bin", None),
        ConflictFileState::text("d.bin", None),
        missing_side,
    );
    let err = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &missing))
        .expect_err("sha-less binary side on duplicate id must be rejected");
    assert_invalid_input(&err, "binary conflict side is missing its blob reference");
}

#[test]
fn text_side_with_binary_sha_rejected() {
    let (_scratch, mut store) = open_store();
    let sha = hydrate(&mut store, b"misfiled");
    let mut side = ConflictFileState::text("t.md", None);
    side.binary_sha256 = Some(sha);
    let c = conflict(
        "text-with-binary",
        "t.md",
        ConflictFileState::text("t.md", None),
        ConflictFileState::text("t.md", None),
        side,
    );
    let err = store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect_err("text side with binary sha must be rejected");
    assert_invalid_input(&err, "text conflict side cannot reference a binary blob");
}

#[test]
fn text_resolve_over_now_binary_path_is_stale_not_clobber() {
    let (_scratch, mut store) = open_store();
    let c = conflict(
        "text-over-binary",
        "occupied.md",
        ConflictFileState::text("occupied.md", None),
        ConflictFileState::text("occupied.md", None),
        ConflictFileState::text(
            "occupied.md",
            Some(incoming_text_snapshot("occupied.md", "incoming body")),
        ),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open text conflict over absent path");

    let binary_sha = write_binary_head(&mut store, "occupied-obj", "occupied.md", b"\x00pic\xff");

    let err = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("text-over-binary", ResolveConflictKind::ApplyIncoming),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect_err("a binary head at the path must make the resolve stale");
    assert_eq!(err.code(), "conflict-stale-target");

    let (kind, bin_sha): (String, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = 'occupied.md'",
                [WS],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .expect("live head");
    assert_eq!(kind, "binary");
    assert_eq!(bin_sha.as_deref(), Some(binary_sha.as_str()));
}

#[test]
fn text_move_resolve_onto_binary_destination_is_occupied_not_clobber() {
    let (_scratch, mut store) = open_store();
    let current = write_file(&mut store, "src.md", "current body");
    let mut incoming = incoming_text_snapshot("dst.md", "current body");
    incoming.blob_sha256 = current.blob_sha256.clone();
    let c = conflict(
        "text-move",
        "src.md",
        ConflictFileState::text("src.md", None),
        ConflictFileState::text("src.md", Some(current)),
        ConflictFileState::text("dst.md", Some(incoming)),
    );
    store
        .write_with(&NoFaults, |tx| insert_text_conflict_if_absent(tx, &c))
        .expect("open move conflict");

    let binary_sha = write_binary_head(&mut store, "dst-obj", "dst.md", b"\x00dst\xff");

    let err = VersionedTextStore::new(&mut store)
        .resolve_text_conflict_with(
            &resolve_input("text-move", ResolveConflictKind::ApplyIncoming),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect_err("a binary head at the destination must be occupied");
    assert_eq!(err.code(), "target-path-exists");

    let (kind, bin_sha): (String, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = 'dst.md'",
                [WS],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .expect("live destination head");
    assert_eq!(kind, "binary");
    assert_eq!(bin_sha.as_deref(), Some(binary_sha.as_str()));
}
