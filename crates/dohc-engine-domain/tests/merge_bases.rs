use std::sync::atomic::{AtomicU64, Ordering};

use dohc_engine_domain::{
    CreateNamedVersion, DomainError, MergeTextFileFromVersion, MergeTextFileResult,
    MergeUnchangedReason, NoFaults, RenameTextFile, ResolveConflictKind, ResolveTextConflict,
    VersionedTextStore, WriteBinaryFile, WriteText, write_binary_file_in_tx,
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

fn open_conflicts(store: &mut EngineStore) -> usize {
    VersionedTextStore::new(store)
        .list_text_conflicts_page(WS, Some("open"), None)
        .expect("list conflicts")
        .len()
}

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
