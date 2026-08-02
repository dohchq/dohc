//! WS-G1: what a version merge does with a path that holds BYTES.
//!
//! The contract: identical bytes on both sides are uncontested; bytes only the
//! SOURCE moved fast-forward through the binary write seam; differing bytes
//! open a conflict the user resolves by side. A binary head has no line merge
//! and no TEXT fast-forward seam, so the merge decision tree must never route
//! one through either.

use dohc_engine_domain::{
    CompareTextFileVersions, ComparisonStatus, ConflictChoice, ConflictContentKind, ConflictStatus,
    CreateNamedVersion, DomainError, MergeTextFileFromVersion, MergeTextFileResult,
    MergeUnchangedReason, NoFaults, ResolveConflictKind, ResolveTextConflict, VersionedTextStore,
    WriteBinaryFile, WriteText, binary_delete_job_id, write_binary_file_in_tx,
};
use dohc_engine_storage::{
    EngineStore, MaterializationOperation, Preimage, hex_sha256, put_binary_blob,
};
use dohc_engine_testkit::ScratchDir;

const WS: &str = "ws-binary-merge";
const NO_FAULTS: NoFaults = NoFaults;

fn open() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("main");
    (scratch, store)
}

fn fork(store: &mut EngineStore) {
    VersionedTextStore::new(store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 50,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("fork");
}

fn write_binary(
    store: &mut EngineStore,
    version_id: &str,
    path: &str,
    bytes: &[u8],
    object_id: &str,
    moment_id: &str,
) -> String {
    let sha256 = hex_sha256(bytes);
    store
        .write_with(&NO_FAULTS, |tx| {
            let stored = put_binary_blob(tx, bytes)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: version_id.to_owned(),
                    object_id: object_id.to_owned(),
                    path: path.to_owned(),
                    binary_sha256: stored,
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: None,
                    now_ms: 120,
                },
            )?;
            Ok::<_, DomainError>(())
        })
        .expect("write binary head");
    sha256
}

fn write_text(store: &mut EngineStore, version_id: &str, path: &str, text: &str, moment: &str) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: version_id.to_owned(),
                object_id: format!("object-{moment}"),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment.to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("write text head");
}

fn merge_input(path: &str, moment: &str, conflict: &str, object: &str) -> MergeTextFileFromVersion {
    MergeTextFileFromVersion {
        workspace_id: WS.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        path: path.to_owned(),
        object_id: object.to_owned(),
        moment_id: moment.to_owned(),
        request_id: None,
        conflict_id: conflict.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 500,
    }
}

fn resolve(id: &str, kind: ResolveConflictKind, suffix: &str) -> ResolveTextConflict {
    ResolveTextConflict {
        workspace_id: WS.to_owned(),
        conflict_id: id.to_owned(),
        resolution: kind,
        object_id: format!("resolved-object-{suffix}"),
        write_moment_id: format!("resolve-write-{suffix}"),
        delete_moment_id: format!("resolve-delete-{suffix}"),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 900,
        request_id: None,
    }
}

fn moment_count(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
        .expect("moment count")
}

fn binary_head_sha(store: &EngineStore, version_id: &str, path: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT binary_sha256 FROM snapshots WHERE workspace_id = ?1 \
                 AND version_id = ?2 AND path = ?3",
                rusqlite::params![WS, version_id, path],
                |row| row.get(0),
            )
        })
        .expect("binary head")
}

fn head_content_kind(store: &EngineStore, version_id: &str, path: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COALESCE(content_kind, 'text') FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                rusqlite::params![WS, version_id, path],
                |row| row.get(0),
            )
        })
        .expect("head content kind")
}

/// Bytes that agree need no decision.
///
/// MUTATION: compare binary sides by their (always empty) text view instead of
/// their content address -> this keeps passing, while its differing-bytes
/// sibling below reports `unchanged` and the merge silently drops the source's
/// bytes.
#[test]
fn equal_bytes_merge_uncontested() {
    let (_scratch, mut store) = open();
    let bytes = b"\x89PNG\x00\x01";
    write_binary(&mut store, "main", "logo.png", bytes, "obj-logo", "m-1");
    fork(&mut store);
    // The source rewrites the SAME bytes, so the two heads still agree.
    write_binary(&mut store, "feat", "logo.png", bytes, "obj-feat-1", "f-1");
    let before = moment_count(&store);

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("equal bytes merge");
    match result {
        MergeTextFileResult::Unchanged {
            reason, comparison, ..
        } => {
            assert_eq!(reason, MergeUnchangedReason::AlreadySame);
            assert_eq!(comparison.status, ComparisonStatus::Same);
        }
        other => panic!("expected an uncontested merge, got {other:?}"),
    }
    assert_eq!(
        moment_count(&store),
        before,
        "an uncontested binary merge writes nothing"
    );
}

/// Differing bytes open a conflict carrying both sides, and each side resolves
/// to its own bytes.
///
/// MUTATION: drop the binary branch from the merge decision tree -> the merge
/// fast-forwards through the TEXT write seam, which reads a binary head as an
/// empty path, and this expects a conflict it never gets.
#[test]
fn differing_bytes_open_a_conflict_resolvable_by_side() {
    let (_scratch, mut store) = open();
    write_binary(
        &mut store,
        "main",
        "logo.png",
        b"\x89PNG\x00\x01",
        "obj-logo",
        "m-1",
    );
    fork(&mut store);
    let main_bytes = b"\x89PNG\xaa";
    let main_sha = write_binary(
        &mut store,
        "main",
        "logo.png",
        main_bytes,
        "obj-main-2",
        "m-2",
    );
    let feat_bytes = b"\x89PNG\xbb\xbb";
    let feat_sha = write_binary(
        &mut store,
        "feat",
        "logo.png",
        feat_bytes,
        "obj-feat-1",
        "f-1",
    );

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("differing bytes merge");
    let conflict = match result {
        MergeTextFileResult::Conflict {
            conflict,
            comparison,
            ..
        } => {
            assert_eq!(comparison.status, ComparisonStatus::Diverged);
            *conflict
        }
        other => panic!("expected a binary conflict, got {other:?}"),
    };
    assert_eq!(conflict.current.content_kind, ConflictContentKind::Binary);
    assert_eq!(
        conflict.current.binary_sha256.as_deref(),
        Some(main_sha.as_str())
    );
    assert_eq!(
        conflict.current.binary_byte_length,
        Some(main_bytes.len() as i64)
    );
    // The recorded current side carries head identity, so a head that lands at
    // this path later cannot pass the exact-head gate on resolve.
    assert_eq!(
        conflict.current.binary_latest_moment_id.as_deref(),
        Some("m-2")
    );
    assert_eq!(
        conflict.incoming.binary_sha256.as_deref(),
        Some(feat_sha.as_str())
    );
    assert_eq!(
        conflict.incoming.binary_byte_length,
        Some(feat_bytes.len() as i64)
    );

    // Keeping the current side writes nothing: main keeps its own bytes.
    let before = moment_count(&store);
    let kept = VersionedTextStore::new(&mut store)
        .resolve_text_conflict(
            &resolve("conflict-1", ResolveConflictKind::KeepCurrent, "keep"),
            &NO_FAULTS,
        )
        .expect("keep the current binary side");
    assert_eq!(kept.conflict.status, ConflictStatus::Resolved);
    assert_eq!(kept.conflict.chosen_from, ConflictChoice::Current);
    assert!(kept.write.is_none() && kept.delete.is_none() && kept.binary_write.is_none());
    assert_eq!(moment_count(&store), before);
    assert_eq!(binary_head_sha(&store, "main", "logo.png"), main_sha);

    // A second conflict over the same pair resolves the OTHER way, so both
    // choices cannot be wired to the same side.
    let reopened = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-2", "conflict-2", "obj-merge-2"),
            &NO_FAULTS,
        )
        .expect("second merge reopens the conflict");
    assert!(matches!(reopened, MergeTextFileResult::Conflict { .. }));
    let applied = VersionedTextStore::new(&mut store)
        .resolve_text_conflict(
            &resolve("conflict-2", ResolveConflictKind::ApplyIncoming, "apply"),
            &NO_FAULTS,
        )
        .expect("apply the incoming binary side");
    assert_eq!(applied.conflict.chosen_from, ConflictChoice::Incoming);
    let binary_write = applied
        .binary_write
        .expect("an applied binary side reports the head it wrote");
    assert_eq!(binary_write.binary_sha256, feat_sha);
    assert_eq!(binary_write.path, "logo.png");
    assert_eq!(binary_write.moment_id, "resolve-write-apply");
    assert!(
        applied.write.is_none(),
        "binary bytes never ride in a text write result"
    );
    assert_eq!(binary_head_sha(&store, "main", "logo.png"), feat_sha);
}

/// The folder must follow the resolution: applying the incoming binary side
/// into the ACTIVE version commits its disk write, keyed on the resolve
/// moment's id and guarded by the head it replaces.
#[test]
fn applying_a_binary_side_into_the_active_version_enqueues_its_materialization() {
    let (_scratch, mut store) = open();
    write_binary(
        &mut store,
        "main",
        "logo.png",
        b"\x89PNG\x00\x01",
        "obj-logo",
        "m-1",
    );
    fork(&mut store);
    let main_sha = write_binary(
        &mut store,
        "main",
        "logo.png",
        b"\x89PNG\xaa",
        "obj-main-m-2",
        "m-2",
    );
    let feat_sha = write_binary(
        &mut store,
        "feat",
        "logo.png",
        b"\x89PNG\xbb\xbb",
        "obj-feat-f-1",
        "f-1",
    );
    VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("merge opens the conflict");

    VersionedTextStore::new(&mut store)
        .resolve_text_conflict(
            &resolve("conflict-1", ResolveConflictKind::ApplyIncoming, "active"),
            &NO_FAULTS,
        )
        .expect("apply the incoming binary side");

    let job = store
        .load_materialization_job("resolve-write-active")
        .expect("load the resolve materialization job")
        .expect("main is active, so the resolved bytes must reach disk");
    assert_eq!(job.content_sha256, feat_sha);
    assert_eq!(job.target_path, "logo.png");
    assert_eq!(job.operation, MaterializationOperation::Write);
    assert_eq!(job.preimage, Preimage::Present(main_sha));
}

/// A NEW binary file, present only in the source: base and current are both
/// absent, so nothing on the target can be lost and the merge fast-forwards
/// instead of asking the user to adjudicate a disagreement that does not exist.
///
/// MUTATION: fire the fast-forward without checking that current equals base ->
/// `differing_bytes_open_a_conflict_resolvable_by_side` FAILS.
#[test]
fn a_new_source_only_binary_file_fast_forwards() {
    let (_scratch, mut store) = open();
    // Seed an unrelated file so the fork carries durable fork-base snapshots.
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    fork(&mut store);
    let feat_bytes = b"\x89PNG\xbb";
    let feat_sha = write_binary(&mut store, "feat", "logo.png", feat_bytes, "obj-f", "f-1");

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("source-only binary merge");
    match result {
        MergeTextFileResult::BinaryWrite { write, comparison } => {
            assert_eq!(comparison.status, ComparisonStatus::IncomingChanged);
            assert!(write.head.binary);
            // The head reports its BINARY address and length, never the empty
            // text view a binary snapshot reads as.
            assert_eq!(write.head.snapshot.blob_sha256, feat_sha);
            assert_eq!(write.head.byte_length, feat_bytes.len() as i64);
            assert_eq!(write.head.snapshot.version_id, "main");
            assert_eq!(write.head.snapshot.path, "logo.png");
            assert_eq!(write.head.snapshot.text, "");
            assert_eq!(write.moment.moment_id, "merge-1");
            assert_eq!(write.object.object_id, "obj-merge-1");
            assert!(!write.deduped);
        }
        other => panic!("expected a binary fast-forward, got {other:?}"),
    }
    assert_eq!(binary_head_sha(&store, "main", "logo.png"), feat_sha);

    // The folder follows: main is active, and a binary write keys its job on
    // the moment id it shares a generation with.
    let job = store
        .load_materialization_job("merge-1")
        .expect("load the merge materialization job")
        .expect("main is active, so the merged bytes must reach disk");
    assert_eq!(job.content_sha256, feat_sha);
    assert_eq!(job.target_path, "logo.png");
    assert_eq!(job.operation, MaterializationOperation::Write);
    assert_eq!(
        job.preimage,
        Preimage::Absent,
        "the target held nothing at this path"
    );
}

/// The same fast-forward over a head the target has NOT touched since the fork:
/// current equals base by content ADDRESS, so only the source moved.
#[test]
fn a_source_only_binary_replacement_fast_forwards_over_the_unchanged_head() {
    let (_scratch, mut store) = open();
    let main_sha = write_binary(
        &mut store,
        "main",
        "logo.png",
        b"\x89PNG\x00\x01",
        "obj-logo",
        "m-1",
    );
    fork(&mut store);
    let feat_sha = write_binary(
        &mut store,
        "feat",
        "logo.png",
        b"\x89PNG\xbb\xbb",
        "obj-feat-f-1",
        "f-1",
    );

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("source-only binary replacement");
    match result {
        MergeTextFileResult::BinaryWrite { write, .. } => {
            assert_eq!(write.head.snapshot.blob_sha256, feat_sha);
            // The path keeps its object identity; the merge id binds only a
            // NEW target path.
            assert_eq!(write.object.object_id, "obj-logo");
        }
        other => panic!("expected a binary fast-forward, got {other:?}"),
    }
    assert_eq!(binary_head_sha(&store, "main", "logo.png"), feat_sha);
    let job = store
        .load_materialization_job("merge-1")
        .expect("load the merge materialization job")
        .expect("main is active, so the merged bytes must reach disk");
    assert_eq!(
        job.preimage,
        Preimage::Present(main_sha),
        "the disk write is guarded by the bytes it replaces"
    );
}

/// Bytes replacing a TEXT head the target has not touched since the fork. The
/// disk write is guarded by the text blob it overwrites.
#[test]
fn a_source_only_binary_change_fast_forwards_over_an_unchanged_text_head() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "notes.md", "shared\n", "m-1");
    fork(&mut store);
    let feat_sha = write_binary(
        &mut store,
        "feat",
        "notes.md",
        b"\x89PNG\x02",
        "obj-feat-f-1",
        "f-1",
    );

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("notes.md", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("bytes over an unchanged text head");
    match result {
        MergeTextFileResult::BinaryWrite { write, .. } => {
            assert_eq!(write.head.snapshot.blob_sha256, feat_sha);
        }
        other => panic!("expected a binary fast-forward, got {other:?}"),
    }
    assert_eq!(head_content_kind(&store, "main", "notes.md"), "binary");
    let job = store
        .load_materialization_job("merge-1")
        .expect("load the merge materialization job")
        .expect("main is active, so the merged bytes must reach disk");
    assert_eq!(
        job.preimage,
        Preimage::Present(hex_sha256(b"shared\n")),
        "the disk write is guarded by the text it replaces"
    );
}

/// An EMPTY text head over a binary base is not a binary fast-forward either. A
/// binary side's text view is empty, so equality read from the text view would
/// let the emptied head stand in for its binary ancestor and the incoming bytes
/// would land on an edit that never shared an ancestor with them.
///
/// MUTATION: compare the fast-forward's sides by their text view instead of
/// their content address -> this fast-forwards instead of conflicting.
#[test]
fn an_empty_text_head_over_a_binary_base_is_not_a_binary_fast_forward() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    write_binary(
        &mut store,
        "main",
        "notes.md",
        b"\x89PNG\x01",
        "obj-notes",
        "m-1",
    );
    fork(&mut store);
    // Main empties the file; the fork replaces the bytes with other bytes.
    write_text(&mut store, "main", "notes.md", "", "m-2");
    write_binary(
        &mut store,
        "feat",
        "notes.md",
        b"\x89PNG\x02\x02",
        "obj-feat-f-1",
        "f-1",
    );

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("notes.md", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("merge an emptied head whose base was binary");
    assert!(
        matches!(result, MergeTextFileResult::Conflict { .. }),
        "an empty text view must never stand in for a binary ancestor, got {result:?}"
    );
    assert_eq!(
        head_content_kind(&store, "main", "notes.md"),
        "text",
        "the emptied text head must survive the refused fast-forward"
    );
}

/// The fast-forward's ledger record round-trips: an exact retry replays the
/// binary write it committed rather than re-reading the live head or falling
/// through to another branch.
#[test]
fn a_replayed_binary_fast_forward_reports_the_head_it_wrote() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    fork(&mut store);
    let feat_sha = write_binary(
        &mut store,
        "feat",
        "logo.png",
        b"\x89PNG\xbb",
        "obj-f",
        "f-1",
    );
    let mut input = merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1");
    input.request_id = Some("merge-request-1".to_owned());

    let first = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(&input, &NO_FAULTS)
        .expect("source-only binary merge");
    let after_first = moment_count(&store);
    let replay = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(&input, &NO_FAULTS)
        .expect("the same request replays");
    match (first, replay) {
        (
            MergeTextFileResult::BinaryWrite { write: first, .. },
            MergeTextFileResult::BinaryWrite {
                write: replayed, ..
            },
        ) => {
            assert!(!first.deduped && replayed.deduped);
            assert_eq!(replayed.head, first.head);
            assert_eq!(replayed.head.snapshot.blob_sha256, feat_sha);
            assert_eq!(replayed.moment.moment_id, "merge-1");
            assert_eq!(replayed.object, first.object);
        }
        (first, replay) => panic!("expected two binary fast-forwards, got {first:?} / {replay:?}"),
    }
    assert_eq!(
        moment_count(&store),
        after_first,
        "a replay records no second moment"
    );
}

/// The OTHER direction of a source-only change: the target holds bytes it has
/// not touched since the fork, and the source replaced them with TEXT. Only the
/// source moved, so the comparison reads `IncomingChanged` — but the merge
/// still goes to the user: the binary fast-forward writes BYTES, and the TEXT
/// fast-forward does not hand its seam a binary current (#491). Resolving does
/// — one click later, `ApplyIncoming` writes the incoming text over the bytes.
///
/// MUTATION: drop the `incoming.binary` gate from the fast-forward -> the merge
/// hands a TEXT blob address to the binary write seam and dies with
/// `binary file write references a missing binary blob`.
#[test]
fn text_replacing_an_untouched_binary_head_opens_a_conflict() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    let main_sha = write_binary(
        &mut store,
        "main",
        "notes.md",
        b"\x89PNG\x01",
        "obj-notes",
        "m-1",
    );
    fork(&mut store);
    // Main keeps the bytes it forked with; the source replaces them with text.
    write_text(&mut store, "feat", "notes.md", "feature text\n", "f-1");

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("notes.md", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("text replacing an untouched binary head");
    match result {
        MergeTextFileResult::Conflict {
            conflict,
            comparison,
            ..
        } => {
            assert_eq!(comparison.status, ComparisonStatus::IncomingChanged);
            assert_eq!(conflict.current.content_kind, ConflictContentKind::Binary);
            assert_eq!(conflict.incoming.content_kind, ConflictContentKind::Text);
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(
        binary_head_sha(&store, "main", "notes.md"),
        main_sha,
        "the target keeps its bytes until the user chooses"
    );
}

/// The comparison RPC must report a binary head as PRESENT. Reading it through
/// the text blob join alone reports an occupied path as empty, which is what
/// let a text merge overwrite bytes.
#[test]
fn comparison_reports_a_binary_head_with_its_address_and_size() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    fork(&mut store);
    let bytes = b"\x89PNG\xbb\xbb\xbb";
    let sha = write_binary(&mut store, "feat", "logo.png", bytes, "obj-f", "f-1");

    let comparison = VersionedTextStore::new(&mut store)
        .compare_text_file_versions(&CompareTextFileVersions {
            workspace_id: WS.to_owned(),
            target_version_id: "main".to_owned(),
            source_version_id: "feat".to_owned(),
            path: "logo.png".to_owned(),
        })
        .expect("compare a binary head");
    let incoming = comparison
        .incoming
        .as_ref()
        .expect("binary head is present");
    assert!(incoming.binary);
    assert_eq!(incoming.snapshot.blob_sha256, sha);
    assert_eq!(incoming.byte_length, bytes.len() as i64);
    assert!(
        incoming.snapshot.text.is_empty(),
        "a binary head carries no text"
    );
    assert_eq!(comparison.status, ComparisonStatus::IncomingChanged);
}

/// The source REMOVED a binary asset the target still holds. Applying the
/// incoming side must remove it from the target's head AND from the folder.
///
/// A binary head's removal carries its own preimage and job id; the text
/// enqueue seam hashes the deleted snapshot's TEXT, which for a binary head is
/// the empty string, so it would queue a disk write guarded by the wrong
/// preimage against the wrong content.
///
/// MUTATION: enqueue the delete through the text seam instead of the binary
/// one -> the binary delete job is missing and the preimage is the empty
/// string's hash.
#[test]
fn applying_an_absent_incoming_side_removes_the_binary_head_and_its_file() {
    let (_scratch, mut store) = open();
    // Seed a second file so the fork carries durable fork-base snapshots.
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    let bytes = b"\x89PNG\xaa\xaa";
    let sha = write_binary(&mut store, "main", "logo.png", bytes, "obj-logo", "m-1");
    fork(&mut store);
    // The source deletes the asset; the target keeps editing it.
    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &dohc_engine_domain::DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: "feat".to_owned(),
                path: "logo.png".to_owned(),
                moment_id: "feat-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 200,
            },
            &NO_FAULTS,
        )
        .expect("the source removes the binary asset");

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("logo.png", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("a removed binary asset merges into a conflict");
    let conflict = match result {
        MergeTextFileResult::Conflict { conflict, .. } => *conflict,
        other => panic!("expected a binary conflict, got {other:?}"),
    };
    assert_eq!(conflict.current.content_kind, ConflictContentKind::Binary);
    assert!(!conflict.incoming.is_present(), "the source removed it");

    let resolved = VersionedTextStore::new(&mut store)
        .resolve_text_conflict(
            &resolve("conflict-1", ResolveConflictKind::ApplyIncoming, "removal"),
            &NO_FAULTS,
        )
        .expect("apply the removal");
    let delete = resolved.delete.expect("the binary head is removed");
    assert_eq!(delete.moment.before_content_kind, "binary");
    assert!(resolved.write.is_none() && resolved.binary_write.is_none());
    assert!(
        head_is_absent(&store, "main", "logo.png"),
        "the target head must be gone"
    );

    // The folder follows: main is active, so the removal is queued as a binary
    // delete keyed on the bytes it removes.
    let job = store
        .load_materialization_job(&binary_delete_job_id("resolve-delete-removal"))
        .expect("load the removal job")
        .expect("main is active, so the file must leave the folder");
    assert_eq!(job.operation, MaterializationOperation::Delete);
    assert_eq!(job.target_path, "logo.png");
    assert_eq!(job.content_sha256, sha);
    assert_eq!(job.preimage, Preimage::Present(sha.clone()));
}

fn head_is_absent(store: &EngineStore, version_id: &str, path: &str) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 \
                 AND version_id = ?2 AND path = ?3",
                rusqlite::params![WS, version_id, path],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("head count")
        == 0
}

/// A path whose FORK BASE is binary but whose two live sides are text has no
/// common text ancestor. A three-way merge would have to invent one, so the
/// two sides go to the user.
#[test]
fn a_binary_base_under_two_text_sides_opens_a_conflict() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    write_binary(
        &mut store,
        "main",
        "notes.md",
        b"\x89PNG\x01",
        "obj-notes",
        "m-1",
    );
    fork(&mut store);
    // Both sides replace the bytes with DIFFERENT text.
    write_text(&mut store, "main", "notes.md", "main text\n", "m-2");
    write_text(&mut store, "feat", "notes.md", "feature text\n", "f-1");

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("notes.md", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("merge a path whose base was binary");
    match result {
        MergeTextFileResult::Conflict { conflict, .. } => {
            assert_eq!(conflict.base.content_kind, ConflictContentKind::Binary);
            assert_eq!(conflict.current.content_kind, ConflictContentKind::Text);
            assert_eq!(conflict.incoming.content_kind, ConflictContentKind::Text);
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
}

/// The same shape with an EMPTY current text file. A binary head's text VIEW is
/// also empty, so a three-way merge fed the base's view would read
/// `local == base` and fast-forward the incoming text over a head that never
/// shared an ancestor with it. The base's kind has to gate the line merge, not
/// only its text.
///
/// MUTATION: gate the line merge on the live sides alone and pass the base's
/// text view to `merge_markdown` -> this merges instead of conflicting.
#[test]
fn an_empty_text_head_over_a_binary_base_is_not_a_fast_forward() {
    let (_scratch, mut store) = open();
    write_text(&mut store, "main", "seed.md", "seed", "seed-moment");
    write_binary(
        &mut store,
        "main",
        "notes.md",
        b"\x89PNG\x01",
        "obj-notes",
        "m-1",
    );
    fork(&mut store);
    // Main empties the file; the fork writes real text. The empty head and the
    // binary base share an empty text view and NOTHING else.
    write_text(&mut store, "main", "notes.md", "", "m-2");
    write_text(&mut store, "feat", "notes.md", "feature text\n", "f-1");

    let result = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("notes.md", "merge-1", "conflict-1", "obj-merge-1"),
            &NO_FAULTS,
        )
        .expect("merge an emptied head whose base was binary");
    assert!(
        matches!(result, MergeTextFileResult::Conflict { .. }),
        "an empty text view must never stand in for a binary ancestor, got {result:?}"
    );
}
