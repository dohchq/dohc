//! Merging a path a second time compares against what was last merged there
//! (#3211), not the fork point: a change already in Main is never asked about
//! again, and a change the version reverts reaches Main.

use std::sync::atomic::{AtomicU64, Ordering};

use dohc_engine_domain::{
    CompareTextFileVersions, ComparisonStatus, CreateNamedVersion, DeleteTextFile, DomainError,
    MergeTextFileFromVersion, MergeTextFileResult, MergeUnchangedReason, NoFaults, RenameTextFile,
    ResolveConflictKind, ResolveTextConflict, VersionedTextStore, WriteBinaryFile, WriteText,
    write_binary_file_in_tx,
};
use dohc_engine_storage::{EngineStore, hex_sha256, put_binary_blob};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const WS: &str = "ws-merge-bases";
const NO_FAULTS: NoFaults = NoFaults;

fn id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("{prefix}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn open() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

fn put(store: &mut EngineStore, version: &str, path: &str, text: &str) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: version.to_owned(),
                object_id: id("object"),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: id("write"),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("write text");
}

fn remove(store: &mut EngineStore, version: &str, path: &str) {
    VersionedTextStore::new(store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: version.to_owned(),
                path: path.to_owned(),
                moment_id: id("delete"),
                request_id: None,
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 110,
            },
            &NO_FAULTS,
        )
        .expect("delete text");
}

fn put_binary(store: &mut EngineStore, version: &str, path: &str, bytes: &[u8]) -> String {
    store
        .write_with(&NO_FAULTS, |tx| {
            let stored = put_binary_blob(tx, bytes)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: version.to_owned(),
                    object_id: id("object"),
                    path: path.to_owned(),
                    binary_sha256: stored,
                    moment_id: id("binary"),
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
        .expect("write binary");
    hex_sha256(bytes)
}

fn merge_request(path: &str) -> MergeTextFileFromVersion {
    MergeTextFileFromVersion {
        workspace_id: WS.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        path: path.to_owned(),
        object_id: id("merged-object"),
        moment_id: id("merge"),
        request_id: None,
        conflict_id: id("conflict"),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 500,
    }
}

fn merge_with(store: &mut EngineStore, input: &MergeTextFileFromVersion) -> MergeTextFileResult {
    VersionedTextStore::new(store)
        .merge_text_file_from_version_with(input, &NO_FAULTS, |_, _| Ok(()))
        .expect("merge")
}

fn merge(store: &mut EngineStore, path: &str) -> MergeTextFileResult {
    merge_with(store, &merge_request(path))
}

/// The merge's outcome as one word, so a failed assertion names it.
fn outcome(result: &MergeTextFileResult) -> &'static str {
    match result {
        MergeTextFileResult::Write { .. } => "write",
        MergeTextFileResult::BinaryWrite { .. } => "binary write",
        MergeTextFileResult::Delete { .. } => "delete",
        MergeTextFileResult::Unchanged {
            reason: MergeUnchangedReason::AlreadySame,
            ..
        } => "already same",
        MergeTextFileResult::Unchanged {
            reason: MergeUnchangedReason::SourceUnchanged,
            ..
        } => "source unchanged",
        MergeTextFileResult::Conflict { .. } => "conflict",
    }
}

fn conflict_id(result: &MergeTextFileResult) -> String {
    match result {
        MergeTextFileResult::Conflict { conflict, .. } => conflict.conflict_id.clone(),
        other => panic!("expected a conflict, got {}", outcome(other)),
    }
}

fn resolve(store: &mut EngineStore, conflict_id: &str, resolution: ResolveConflictKind) {
    VersionedTextStore::new(store)
        .resolve_text_conflict_with(
            &ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id: conflict_id.to_owned(),
                resolution,
                object_id: id("resolved-object"),
                write_moment_id: id("resolve-write"),
                delete_moment_id: id("resolve-delete"),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 900,
                request_id: None,
                conflict_answer_budget_bytes: usize::MAX,
            },
            &NO_FAULTS,
            |_, _, _| Ok(()),
            |_, _, ()| Ok(()),
        )
        .expect("resolve");
}

fn main_text(store: &mut EngineStore, path: &str) -> Option<String> {
    VersionedTextStore::new(store)
        .read_text(WS, "main", path)
        .expect("read main")
        .map(|snapshot| snapshot.text)
}

fn main_binary(store: &EngineStore, path: &str) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT s.binary_sha256 FROM path_aliases a JOIN snapshots s \
                 USING (workspace_id, version_id, object_id, path) \
                 WHERE a.workspace_id = ?1 AND a.version_id = 'main' AND a.path = ?2",
                rusqlite::params![WS, path],
                |row| row.get(0),
            )
        })
        .expect("read main bytes")
}

fn status(store: &mut EngineStore, path: &str) -> ComparisonStatus {
    VersionedTextStore::new(store)
        .compare_text_file_versions(&CompareTextFileVersions {
            workspace_id: WS.to_owned(),
            target_version_id: "main".to_owned(),
            source_version_id: "feat".to_owned(),
            path: path.to_owned(),
        })
        .expect("compare")
        .status
}

fn open_conflicts(store: &mut EngineStore) -> usize {
    VersionedTextStore::new(store)
        .list_text_conflicts_page(WS, Some("open"), None)
        .expect("list conflicts")
        .len()
}

/// Every row of `table`, each column written out, for byte-for-byte equality.
fn dump(store: &EngineStore, table: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2, 3"))?;
            let columns = stmt.column_count();
            let rows = stmt.query_map([], |row| {
                (0..columns)
                    .map(|index| {
                        row.get::<_, rusqlite::types::Value>(index)
                            .map(|value| format!("{value:?}"))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map(|cells| cells.join("|"))
            })?;
            rows.collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .expect("dump table")
}

const LINES: &str = "1\n2\n3\n4\n5";

/// (a) The issue's steps: change a line, merge, change the same line again,
/// merge again. The newer change merges without a question.
#[test]
fn changing_a_merged_line_again_merges_without_a_question() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "a.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "a.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "a.md")), "write");

    put(&mut store, "feat", "a.md", "1\n2\nTHREE\n4\n5");
    assert_eq!(
        status(&mut store, "a.md"),
        ComparisonStatus::IncomingChanged
    );
    assert_eq!(outcome(&merge(&mut store, "a.md")), "write");
    assert_eq!(
        main_text(&mut store, "a.md").as_deref(),
        Some("1\n2\nTHREE\n4\n5")
    );
    assert_eq!(open_conflicts(&mut store), 0);
}

/// (b) A clean three-way merge, then the version changes the lines it merged
/// again while Main's own change stays.
#[test]
fn a_line_merge_then_the_same_lines_again_stays_clean() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "b.md", LINES);
    fork(&mut store);
    put(&mut store, "main", "b.md", "one\n2\n3\n4\n5");
    put(&mut store, "feat", "b.md", "1\n2\n3\n4\nfive");
    assert_eq!(outcome(&merge(&mut store, "b.md")), "write");
    assert_eq!(
        main_text(&mut store, "b.md").as_deref(),
        Some("one\n2\n3\n4\nfive")
    );

    put(&mut store, "feat", "b.md", "1\n2\n3\n4\nFIVE");
    assert_eq!(outcome(&merge(&mut store, "b.md")), "write");
    assert_eq!(
        main_text(&mut store, "b.md").as_deref(),
        Some("one\n2\n3\n4\nFIVE")
    );
}

/// (c) A resolved conflict counts as merged whichever side it kept. The
/// version's next change is on line 5, which no resolution touched, so it
/// merges cleanly and keeps line 1 as resolved.
#[test]
fn a_resolved_conflict_is_not_asked_again() {
    let (_scratch, mut store) = open();
    // Applying the version's side leaves Main equal to it, so the repeat
    // merge finds nothing to do before it consults the base at all.
    let cases = [
        (
            "keep.md",
            ResolveConflictKind::KeepCurrent,
            "main",
            "source unchanged",
        ),
        (
            "apply.md",
            ResolveConflictKind::ApplyIncoming,
            "feat",
            "already same",
        ),
        (
            "merged.md",
            ResolveConflictKind::ApplyMerged {
                text: "both\n2\n3\n4\n5".to_owned(),
            },
            "both",
            "source unchanged",
        ),
    ];
    for (path, ..) in &cases {
        put(&mut store, "main", path, LINES);
    }
    fork(&mut store);
    for (path, resolution, first_line, repeat) in cases {
        put(&mut store, "main", path, "main\n2\n3\n4\n5");
        put(&mut store, "feat", path, "feat\n2\n3\n4\n5");
        let conflict = conflict_id(&merge(&mut store, path));
        resolve(&mut store, &conflict, resolution);

        assert_eq!(
            outcome(&merge(&mut store, path)),
            repeat,
            "{path}: the resolved change is not asked about again"
        );
        put(&mut store, "feat", path, "feat\n2\n3\n4\nfive");
        assert_eq!(outcome(&merge(&mut store, path)), "write", "{path}");
        assert_eq!(
            main_text(&mut store, path),
            Some(format!("{first_line}\n2\n3\n4\nfive")),
            "{path}"
        );
    }
    assert_eq!(open_conflicts(&mut store), 0);
}

/// (d) A merged delete, then the version creates the file again.
#[test]
fn a_file_recreated_after_its_merged_delete_merges_as_new() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "d.md", "old");
    fork(&mut store);
    remove(&mut store, "feat", "d.md");
    assert_eq!(outcome(&merge(&mut store, "d.md")), "delete");
    assert_eq!(main_text(&mut store, "d.md"), None);

    put(&mut store, "feat", "d.md", "new");
    assert_eq!(outcome(&merge(&mut store, "d.md")), "write");
    assert_eq!(main_text(&mut store, "d.md").as_deref(), Some("new"));
}

/// (e) A rename merges path by path: the new path arrives, the old path's
/// deletion still merges, and a later edit at the new path merges cleanly.
#[test]
fn a_renamed_file_merges_by_path() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "old.md", "x");
    fork(&mut store);
    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: "feat".to_owned(),
                from_path: "old.md".to_owned(),
                to_path: "new.md".to_owned(),
                moment_id: id("rename"),
                request_id: None,
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 120,
            },
            &NO_FAULTS,
        )
        .expect("rename");

    assert_eq!(outcome(&merge(&mut store, "new.md")), "write");
    assert_eq!(outcome(&merge(&mut store, "old.md")), "delete");
    assert_eq!(main_text(&mut store, "old.md"), None);

    put(&mut store, "feat", "new.md", "y");
    assert_eq!(outcome(&merge(&mut store, "new.md")), "write");
    assert_eq!(main_text(&mut store, "new.md").as_deref(), Some("y"));
}

/// (f) Main undoes a merge; merging again applies the version's change again.
/// A repeat merge in between, which finds nothing to do, does not hide the
/// undo.
#[test]
fn merging_again_after_main_undoes_the_merge_applies_it_again() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "f.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "f.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "f.md")), "write");
    assert_eq!(outcome(&merge(&mut store, "f.md")), "already same");

    put(&mut store, "main", "f.md", LINES);
    assert_eq!(
        status(&mut store, "f.md"),
        ComparisonStatus::IncomingChanged
    );
    assert_eq!(outcome(&merge(&mut store, "f.md")), "write");
    assert_eq!(
        main_text(&mut store, "f.md").as_deref(),
        Some("1\n2\nthree\n4\n5")
    );
}

/// (g) Main edits other lines after a merge; the version's next change and
/// Main's edit are both kept.
#[test]
fn main_edits_to_other_lines_survive_the_next_merge() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "g.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "g.md", "1\n2\n3\n4\nfive");
    assert_eq!(outcome(&merge(&mut store, "g.md")), "write");

    put(&mut store, "main", "g.md", "one\n2\n3\n4\nfive");
    assert_eq!(outcome(&merge(&mut store, "g.md")), "source unchanged");
    put(&mut store, "feat", "g.md", "1\n2\nthree\n4\nfive");
    assert_eq!(outcome(&merge(&mut store, "g.md")), "write");
    assert_eq!(
        main_text(&mut store, "g.md").as_deref(),
        Some("one\n2\nthree\n4\nfive")
    );
}

/// (h) Merging never changes the frozen fork point, which sync replays.
#[test]
fn merges_leave_the_fork_point_untouched() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "take.md", LINES);
    put(&mut store, "main", "conflict.md", LINES);
    put(&mut store, "main", "gone.md", LINES);
    fork(&mut store);
    let frozen = dump(&store, "fork_base_snapshots");
    assert!(!frozen.is_empty());

    put(&mut store, "feat", "take.md", "taken");
    put(&mut store, "main", "conflict.md", "main");
    put(&mut store, "feat", "conflict.md", "feat");
    remove(&mut store, "feat", "gone.md");
    merge(&mut store, "take.md");
    let conflict = conflict_id(&merge(&mut store, "conflict.md"));
    resolve(&mut store, &conflict, ResolveConflictKind::ApplyIncoming);
    merge(&mut store, "gone.md");

    assert_eq!(dump(&store, "fork_base_snapshots"), frozen);
}

/// (i) An exact retry of a merge returns what it returned the first time and
/// does not move the path's merge base back.
#[test]
fn a_replayed_merge_leaves_the_merge_base_alone() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "i.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "i.md", "1\n2\nthree\n4\n5");
    let mut first = merge_request("i.md");
    first.request_id = Some("merge-i-first".to_owned());
    assert_eq!(outcome(&merge_with(&mut store, &first)), "write");

    put(&mut store, "feat", "i.md", "1\n2\nTHREE\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "i.md")), "write");
    let bases = dump(&store, "merge_bases");

    assert_eq!(outcome(&merge_with(&mut store, &first)), "write");
    assert_eq!(dump(&store, "merge_bases"), bases);
    assert_eq!(
        main_text(&mut store, "i.md").as_deref(),
        Some("1\n2\nTHREE\n4\n5")
    );
}

/// (j) The version reverts a change it merged; the next merge brings the
/// revert to Main.
#[test]
fn a_reverted_change_reaches_main() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "j.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "j.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "j.md")), "write");

    put(&mut store, "feat", "j.md", LINES);
    assert_eq!(
        status(&mut store, "j.md"),
        ComparisonStatus::IncomingChanged
    );
    assert_eq!(outcome(&merge(&mut store, "j.md")), "write");
    assert_eq!(main_text(&mut store, "j.md").as_deref(), Some(LINES));
}

/// (k) A partial revert: lines A and B were added and merged, then the
/// version removes B. The next merge removes B from Main and keeps Main's own
/// edit to line 1.
#[test]
fn a_partly_reverted_change_reaches_main() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "k.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "k.md", "1\n2\n3\nA\nB\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "k.md")), "write");

    put(&mut store, "main", "k.md", "one\n2\n3\nA\nB\n4\n5");
    put(&mut store, "feat", "k.md", "1\n2\n3\nA\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "k.md")), "write");
    assert_eq!(
        main_text(&mut store, "k.md").as_deref(),
        Some("one\n2\n3\nA\n4\n5")
    );
}

/// (l) Main rewrites the lines a merge brought; the version does not touch
/// them again. Merging is a no-op, twice in a row.
#[test]
fn main_rewriting_merged_lines_is_left_alone() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "l.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "l.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "l.md")), "write");

    put(&mut store, "main", "l.md", "1\n2\nmain's three\n4\n5");
    assert_eq!(status(&mut store, "l.md"), ComparisonStatus::CurrentChanged);
    for _ in 0..2 {
        assert_eq!(outcome(&merge(&mut store, "l.md")), "source unchanged");
    }
    assert_eq!(
        main_text(&mut store, "l.md").as_deref(),
        Some("1\n2\nmain's three\n4\n5")
    );
    assert_eq!(open_conflicts(&mut store), 0);
}

/// (m) Main undoes the second of two merges; merging again is clean and
/// leaves Main equal to the version.
#[test]
fn undoing_the_second_of_two_merges_then_merging_again_is_clean() {
    let (_scratch, mut store) = open();
    put(&mut store, "main", "m.md", LINES);
    fork(&mut store);
    put(&mut store, "feat", "m.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "m.md")), "write");
    put(&mut store, "feat", "m.md", "1\n2\nthree\n4\nfive");
    assert_eq!(outcome(&merge(&mut store, "m.md")), "write");

    put(&mut store, "main", "m.md", "1\n2\nthree\n4\n5");
    assert_eq!(outcome(&merge(&mut store, "m.md")), "write");
    assert_eq!(
        main_text(&mut store, "m.md").as_deref(),
        Some("1\n2\nthree\n4\nfive")
    );
    assert_eq!(open_conflicts(&mut store), 0);
}

/// Bytes through each branch: taken bytes are the next base, so Main's later
/// bytes are left alone; a resolved conflict is not asked again; new bytes
/// from the version conflict with Main's.
#[test]
fn binary_merges_compare_against_the_last_merged_bytes() {
    let (_scratch, mut store) = open();
    put_binary(&mut store, "main", "take.png", b"\x89PNG-base");
    put_binary(&mut store, "main", "conflict.png", b"\x89PNG-base");
    fork(&mut store);

    let taken = put_binary(&mut store, "feat", "take.png", b"\x89PNG-feat");
    assert_eq!(outcome(&merge(&mut store, "take.png")), "binary write");
    assert_eq!(main_binary(&store, "take.png"), Some(taken));
    let main_bytes = put_binary(&mut store, "main", "take.png", b"\x89PNG-main");
    assert_eq!(outcome(&merge(&mut store, "take.png")), "source unchanged");
    assert_eq!(main_binary(&store, "take.png"), Some(main_bytes));

    let kept = put_binary(&mut store, "main", "conflict.png", b"\x89PNG-main");
    put_binary(&mut store, "feat", "conflict.png", b"\x89PNG-feat");
    let conflict = conflict_id(&merge(&mut store, "conflict.png"));
    resolve(&mut store, &conflict, ResolveConflictKind::KeepCurrent);
    assert_eq!(
        outcome(&merge(&mut store, "conflict.png")),
        "source unchanged"
    );
    assert_eq!(main_binary(&store, "conflict.png"), Some(kept));

    put_binary(&mut store, "feat", "conflict.png", b"\x89PNG-feat-2");
    assert_eq!(outcome(&merge(&mut store, "conflict.png")), "conflict");
}
