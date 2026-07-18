#![allow(
    clippy::drop_non_drop,
    reason = "explicit drops end mutable EngineStore fixture borrows between test phases"
)]

use dohc_engine_domain::{
    CompareTextFileVersions, ComparisonStatus, ConflictChoice, ConflictContentKind,
    ConflictFileState, ConflictMetadata, ConflictResolution, ConflictStatus, CreateNamedVersion,
    DeleteTextFile, DomainError, MergeTextFileFromVersion, MergeTextFileResult,
    MergeUnchangedReason, NoFaults, ResolveConflictKind, ResolveTextConflict, TextConflict,
    TextSnapshot, VersionFileChangeStatus, VersionedTextStore, WriteBinaryFile, WriteText,
    insert_text_conflict_if_absent, live_state_matches_conflict_current, store::text_blob_sha256,
    write_binary_file_in_tx,
};
use dohc_engine_files::{DurabilityPolicy, JobOutcome, NoBackoff, StdReplacer, run_pending_jobs};
use dohc_engine_storage::{
    EngineStore, FaultPoint, JobStatus, MaterializationOperation, Preimage, hex_sha256,
    put_binary_blob,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};

const WS: &str = "ws-r06";
const NO_FAULTS: NoFaults = NoFaults;

fn write(version: &str, path: &str, text: &str, moment: &str, object: &str) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        object_id: object.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        author_json: None,
        now_ms: 100,
        request_id: None,
    }
}

fn delete(version: &str, path: &str, moment: &str) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        path: path.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        author_json: None,
        now_ms: 110,
    }
}

fn fork(vt: &mut VersionedTextStore<'_>) {
    vt.create_named_version(
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

fn open() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("main");
    (scratch, store)
}

fn moment_count(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
        .expect("moment count")
}

fn merge_input(path: &str, moment: &str, conflict: &str, object: &str) -> MergeTextFileFromVersion {
    MergeTextFileFromVersion {
        workspace_id: WS.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        path: path.to_owned(),
        object_id: object.to_owned(),
        moment_id: moment.to_owned(),
        conflict_id: conflict.to_owned(),
        metadata_origin: "agent".to_owned(),
        author_json: None,
        now_ms: 500,
    }
}

#[test]
fn compare_requires_named_durable_fork_base_and_classifies_all_statuses() {
    let (_scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    for (index, path) in ["same.md", "incoming.md", "current.md", "diverged.md"]
        .iter()
        .enumerate()
    {
        vt.write_text(
            &write(
                "main",
                path,
                "base",
                &format!("base-{index}"),
                &format!("o-{index}"),
            ),
            &NO_FAULTS,
        )
        .expect("base write");
    }
    fork(&mut vt);
    vt.write_text(
        &write("feat", "incoming.md", "incoming", "mi", "ignored"),
        &NO_FAULTS,
    )
    .expect("incoming");
    vt.write_text(
        &write("main", "current.md", "current", "mc", "ignored"),
        &NO_FAULTS,
    )
    .expect("current");
    vt.write_text(
        &write("main", "diverged.md", "current", "mdc", "ignored"),
        &NO_FAULTS,
    )
    .expect("div current");
    vt.write_text(
        &write("feat", "diverged.md", "incoming", "mdi", "ignored"),
        &NO_FAULTS,
    )
    .expect("div incoming");

    let compare = |path: &str| {
        vt.compare_text_file_versions(&CompareTextFileVersions {
            workspace_id: WS.to_owned(),
            target_version_id: "main".to_owned(),
            source_version_id: "feat".to_owned(),
            path: path.to_owned(),
        })
        .expect("compare")
        .status
    };
    assert_eq!(compare("same.md"), ComparisonStatus::Same);
    assert_eq!(compare("incoming.md"), ComparisonStatus::IncomingChanged);
    assert_eq!(compare("current.md"), ComparisonStatus::CurrentChanged);
    assert_eq!(compare("diverged.md"), ComparisonStatus::Diverged);

    let err = vt
        .compare_text_file_versions(&CompareTextFileVersions {
            workspace_id: WS.to_owned(),
            target_version_id: "feat".to_owned(),
            source_version_id: "main".to_owned(),
            path: "same.md".to_owned(),
        })
        .expect_err("main is not a named fork");
    assert_eq!(err.code(), "fork-base-not-found");

    drop(vt);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "DELETE FROM fork_base_snapshots WHERE workspace_id = ?1 AND version_id = 'feat'",
                [WS],
            )
            .map_err(|_| DomainError::StateCorrupt {
                reason: "test fixture mutation failed",
            })?;
            Ok::<_, DomainError>(())
        })
        .expect("delete durable bases");
    let vt = VersionedTextStore::new(&mut store);
    let err = vt
        .compare_text_file_versions(&CompareTextFileVersions {
            workspace_id: WS.to_owned(),
            target_version_id: "main".to_owned(),
            source_version_id: "feat".to_owned(),
            path: "same.md".to_owned(),
        })
        .expect_err("durable rows required");
    assert_eq!(err.code(), "fork-base-not-found");
}

#[test]
fn merge_decision_tree_writes_deletes_merges_and_opens_conflict() {
    let (_scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    let bases = [
        ("same.md", "same"),
        ("source-unchanged.md", "base"),
        ("ff-write.md", "base"),
        ("ff-delete.md", "base"),
        ("auto.md", "a\nb\nc"),
        ("conflict.md", "a\nb"),
    ];
    for (index, (path, text)) in bases.iter().enumerate() {
        vt.write_text(
            &write(
                "main",
                path,
                text,
                &format!("b-{index}"),
                &format!("ob-{index}"),
            ),
            &NO_FAULTS,
        )
        .expect("base");
    }
    fork(&mut vt);
    vt.write_text(
        &write("main", "source-unchanged.md", "local", "m-su", "ignored"),
        &NO_FAULTS,
    )
    .expect("source unchanged setup");
    vt.write_text(
        &write("feat", "ff-write.md", "incoming", "m-fw", "ignored"),
        &NO_FAULTS,
    )
    .expect("ff write setup");
    vt.delete_text_file(&delete("feat", "ff-delete.md", "m-fd"), &NO_FAULTS)
        .expect("ff delete setup");
    vt.write_text(
        &write("main", "auto.md", "A\nb\nc", "m-ac", "ignored"),
        &NO_FAULTS,
    )
    .expect("auto current");
    vt.write_text(
        &write("feat", "auto.md", "a\nb\nC", "m-ai", "ignored"),
        &NO_FAULTS,
    )
    .expect("auto incoming");
    vt.write_text(
        &write("main", "conflict.md", "local\nb", "m-cc", "ignored"),
        &NO_FAULTS,
    )
    .expect("conflict current");
    vt.write_text(
        &write("feat", "conflict.md", "remote\nb", "m-ci", "ignored"),
        &NO_FAULTS,
    )
    .expect("conflict incoming");

    assert!(matches!(
        vt.merge_text_file_from_version(
            &merge_input("same.md", "merge-same", "c-same", "new-same"),
            &NO_FAULTS,
        )
        .expect("same"),
        MergeTextFileResult::Unchanged {
            reason: MergeUnchangedReason::AlreadySame,
            ..
        }
    ));
    assert!(matches!(
        vt.merge_text_file_from_version(
            &merge_input("source-unchanged.md", "merge-su", "c-su", "new-su"),
            &NO_FAULTS,
        )
        .expect("source unchanged"),
        MergeTextFileResult::Unchanged {
            reason: MergeUnchangedReason::SourceUnchanged,
            ..
        }
    ));
    let ff = vt
        .merge_text_file_from_version(
            &merge_input("ff-write.md", "merge-fw", "c-fw", "new-fw"),
            &NO_FAULTS,
        )
        .expect("ff write");
    assert!(matches!(ff, MergeTextFileResult::Write { .. }));
    assert_eq!(
        vt.read_text(WS, "main", "ff-write.md")
            .expect("read")
            .expect("present")
            .text,
        "incoming"
    );
    assert!(matches!(
        vt.merge_text_file_from_version(
            &merge_input("ff-delete.md", "merge-fd", "c-fd", "new-fd"),
            &NO_FAULTS,
        )
        .expect("ff delete"),
        MergeTextFileResult::Delete { .. }
    ));
    assert!(
        vt.read_text(WS, "main", "ff-delete.md")
            .expect("read")
            .is_none()
    );
    assert!(matches!(
        vt.merge_text_file_from_version(
            &merge_input("auto.md", "merge-auto", "c-auto", "new-auto"),
            &NO_FAULTS,
        )
        .expect("auto"),
        MergeTextFileResult::Write { .. }
    ));
    assert_eq!(
        vt.read_text(WS, "main", "auto.md")
            .expect("read")
            .expect("present")
            .text,
        "A\nb\nC"
    );
    assert!(matches!(
        vt.merge_text_file_from_version(
            &merge_input("conflict.md", "merge-conflict", "c-open", "new-conflict"),
            &NO_FAULTS,
        )
        .expect("conflict"),
        MergeTextFileResult::Conflict { .. }
    ));
    assert_eq!(
        vt.list_text_conflicts(WS, Some("open"))
            .expect("list")
            .len(),
        1
    );

    drop(vt);
    let write_job = store
        .load_materialization_job("merge-mat_merge-fw")
        .expect("job")
        .expect("write job");
    assert_eq!(write_job.operation, MaterializationOperation::Write);
    assert!(matches!(write_job.preimage, Preimage::Present(_)));
    let delete_job = store
        .load_materialization_job("merge-mat_merge-fd")
        .expect("job")
        .expect("delete job");
    assert_eq!(delete_job.operation, MaterializationOperation::Delete);
}

#[test]
fn compare_version_files_classifies_omits_identical_and_sorts() {
    let (_scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    for (index, (path, text)) in [
        ("z-delete.md", "z"),
        ("m-mod.md", "old"),
        ("same.md", "same"),
    ]
    .iter()
    .enumerate()
    {
        vt.write_text(
            &write(
                "main",
                path,
                text,
                &format!("v-{index}"),
                &format!("vo-{index}"),
            ),
            &NO_FAULTS,
        )
        .expect("base");
    }
    fork(&mut vt);
    vt.delete_text_file(&delete("feat", "z-delete.md", "v-del"), &NO_FAULTS)
        .expect("delete");
    vt.write_text(
        &write("feat", "m-mod.md", "new", "v-mod", "ignored"),
        &NO_FAULTS,
    )
    .expect("modify");
    vt.write_text(
        &write("feat", "a-add.md", "add", "v-add", "vo-add"),
        &NO_FAULTS,
    )
    .expect("add");

    let changes = vt
        .compare_version_files(WS, "feat", "main")
        .expect("compare versions");
    assert_eq!(
        changes
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a-add.md", "m-mod.md", "z-delete.md"]
    );
    assert_eq!(changes[0].status, VersionFileChangeStatus::Added);
    assert_eq!(changes[1].status, VersionFileChangeStatus::Modified);
    assert_eq!(changes[2].status, VersionFileChangeStatus::Deleted);
}

fn conflict(
    id: &str,
    path: &str,
    current: dohc_engine_domain::TextSnapshot,
    incoming: dohc_engine_domain::TextSnapshot,
) -> TextConflict {
    TextConflict {
        conflict_id: id.to_owned(),
        workspace_id: WS.to_owned(),
        path: path.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        created_at_ms: 200,
        updated_at_ms: 200,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("agent"),
        base: ConflictFileState::text(path, None),
        current: ConflictFileState::text(path, Some(current)),
        incoming: ConflictFileState::text(path, Some(incoming)),
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
        metadata_origin: "agent".to_owned(),
        author_json: None,
        now_ms: 900,
        request_id: None,
    }
}

#[test]
fn conflict_primitives_filter_order_and_insert_if_absent() {
    let (_scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(
        &write("main", "a.md", "base", "cp-base", "cp-o"),
        &NO_FAULTS,
    )
    .expect("base");
    fork(&mut vt);
    let current = vt
        .read_text(WS, "main", "a.md")
        .expect("read")
        .expect("current");
    let incoming = vt
        .read_text(WS, "feat", "a.md")
        .expect("read")
        .expect("incoming");
    drop(vt);

    let mut later = conflict("later", "a.md", current.clone(), incoming.clone());
    later.created_at_ms = 20;
    let mut second = conflict("b", "a.md", current.clone(), incoming.clone());
    second.created_at_ms = 10;
    let mut first = conflict("a", "a.md", current, incoming);
    first.created_at_ms = 10;
    first.status = ConflictStatus::Resolved;
    first.resolution = Some(ConflictResolution::KeptCurrent);
    store
        .write_with(&NO_FAULTS, |tx| {
            assert!(insert_text_conflict_if_absent(tx, &later)?);
            assert!(!insert_text_conflict_if_absent(tx, &later)?);
            assert!(insert_text_conflict_if_absent(tx, &second)?);
            assert!(insert_text_conflict_if_absent(tx, &first)?);
            Ok::<_, DomainError>(())
        })
        .expect("insert conflicts");

    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.list_text_conflicts(WS, None)
            .expect("all")
            .iter()
            .map(|item| item.conflict_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "later"]
    );
    assert_eq!(
        vt.list_text_conflicts(WS, Some("open"))
            .expect("open")
            .len(),
        2
    );
    assert_eq!(
        vt.list_text_conflicts(WS, Some("resolved"))
            .expect("resolved")
            .len(),
        1
    );
    assert_eq!(
        vt.list_text_conflicts(WS, Some("bogus"))
            .expect_err("bad filter")
            .code(),
        "invalid-input"
    );
}

#[test]
fn insert_text_conflict_rejects_binary_side() {
    let (_scratch, mut store) = open();
    let mut record = TextConflict {
        conflict_id: "binary-gate".to_owned(),
        workspace_id: WS.to_owned(),
        path: "binary.bin".to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        created_at_ms: 200,
        updated_at_ms: 200,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("sync"),
        base: ConflictFileState::text("binary.bin", None),
        current: ConflictFileState::text("binary.bin", None),
        incoming: ConflictFileState::text("binary.bin", None),
    };
    record.incoming.content_kind = ConflictContentKind::Binary;

    let error = store
        .write_with(&NO_FAULTS, |tx| insert_text_conflict_if_absent(tx, &record))
        .expect_err("binary side must fail closed");
    assert_eq!(error.code(), "invalid-input");
}

#[test]
fn insert_text_conflict_persists_side_blobs_for_replicated_conflict() {
    // Mirror an R10 peer receiving a conflict.open whose side text blobs it has
    // never materialized: the blob FKs must hold because the insert persists them
    // (matching TS insertConflictFileState's putBlob), not rely on prior writes.
    let (_scratch, mut store) = open();
    let incoming_text = "incoming-from-peer";
    let side = TextSnapshot {
        workspace_id: WS.to_owned(),
        version_id: "feat".to_owned(),
        object_id: "o-peer".to_owned(),
        path: "peer.md".to_owned(),
        text: incoming_text.to_owned(),
        blob_sha256: text_blob_sha256(incoming_text),
        updated_at_ms: 10,
        latest_moment_id: "m-peer".to_owned(),
        metadata_origin: "sync".to_owned(),
    };
    let record = TextConflict {
        conflict_id: "replicated".to_owned(),
        workspace_id: WS.to_owned(),
        path: "peer.md".to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        created_at_ms: 200,
        updated_at_ms: 200,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("sync"),
        base: ConflictFileState::text("peer.md", None),
        current: ConflictFileState::text("peer.md", None),
        incoming: ConflictFileState::text("peer.md", Some(side)),
    };
    store
        .write_with(&NO_FAULTS, |tx| {
            assert!(insert_text_conflict_if_absent(tx, &record)?);
            Ok::<_, DomainError>(())
        })
        .expect("insert with unmaterialized side blob");

    let vt = VersionedTextStore::new(&mut store);
    let conflicts = vt.list_text_conflicts(WS, None).expect("list");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]
            .incoming
            .snapshot
            .as_ref()
            .expect("incoming side")
            .text,
        incoming_text
    );
}

#[test]
fn resolve_conflicts_covers_apply_move_merge_keep_and_stale_gate() {
    let (_scratch, mut store) = open();
    let paths = [
        "same.md",
        "move.md",
        "occupied.md",
        "merged.md",
        "keep.md",
        "stale.md",
    ];
    let mut vt = VersionedTextStore::new(&mut store);
    for (index, path) in paths.iter().enumerate() {
        vt.write_text(
            &write(
                "main",
                path,
                "base",
                &format!("r-base-{index}"),
                &format!("r-o-{index}"),
            ),
            &NO_FAULTS,
        )
        .expect("base");
    }
    fork(&mut vt);
    for (index, path) in paths.iter().enumerate() {
        vt.write_text(
            &write(
                "main",
                path,
                &format!("current-{index}"),
                &format!("r-current-{index}"),
                "ignored",
            ),
            &NO_FAULTS,
        )
        .expect("current");
        vt.write_text(
            &write(
                "feat",
                path,
                &format!("incoming-{index}"),
                &format!("r-incoming-{index}"),
                "ignored",
            ),
            &NO_FAULTS,
        )
        .expect("incoming");
    }
    vt.write_text(
        &write("main", "taken.md", "occupied", "r-taken", "r-taken-o"),
        &NO_FAULTS,
    )
    .expect("occupied destination");

    let mut records = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let current = vt
            .read_text(WS, "main", path)
            .expect("read")
            .expect("current");
        let incoming = vt
            .read_text(WS, "feat", path)
            .expect("read")
            .expect("incoming");
        let mut record = conflict(&format!("resolve-{index}"), path, current, incoming);
        if *path == "move.md" {
            record.incoming.path = "moved.md".to_owned();
        }
        if *path == "occupied.md" {
            record.incoming.path = "taken.md".to_owned();
        }
        records.push(record);
    }
    drop(vt);
    store
        .write_with(&NO_FAULTS, |tx| {
            for record in &records {
                insert_text_conflict_if_absent(tx, record)?;
            }
            Ok::<_, DomainError>(())
        })
        .expect("seed conflicts");

    let mut vt = VersionedTextStore::new(&mut store);
    vt.resolve_text_conflict(
        &resolve("resolve-0", ResolveConflictKind::ApplyIncoming, "same"),
        &NO_FAULTS,
    )
    .expect("apply incoming same path");
    assert_eq!(
        vt.read_text(WS, "main", "same.md")
            .expect("read")
            .expect("present")
            .text,
        "incoming-0"
    );

    vt.resolve_text_conflict(
        &resolve("resolve-1", ResolveConflictKind::ApplyIncoming, "move"),
        &NO_FAULTS,
    )
    .expect("apply divergent move");
    assert!(vt.read_text(WS, "main", "move.md").expect("old").is_none());
    assert_eq!(
        vt.read_text(WS, "main", "moved.md")
            .expect("new")
            .expect("present")
            .text,
        "incoming-1"
    );

    assert_eq!(
        vt.resolve_text_conflict(
            &resolve("resolve-2", ResolveConflictKind::ApplyIncoming, "occupied"),
            &NO_FAULTS,
        )
        .expect_err("occupied destination")
        .code(),
        "target-path-exists"
    );

    vt.resolve_text_conflict(
        &resolve(
            "resolve-3",
            ResolveConflictKind::ApplyMerged {
                text: "combined".to_owned(),
            },
            "merged",
        ),
        &NO_FAULTS,
    )
    .expect("apply merged");
    assert_eq!(
        vt.read_text(WS, "main", "merged.md")
            .expect("read")
            .expect("present")
            .text,
        "combined"
    );

    let keep = resolve("resolve-4", ResolveConflictKind::KeepCurrent, "keep");
    vt.resolve_text_conflict(&keep, &NO_FAULTS)
        .expect("keep current");
    vt.resolve_text_conflict(&keep, &NO_FAULTS)
        .expect("TS parity: keep-current re-resolve is not status-idempotent");
    assert_eq!(
        vt.read_text(WS, "main", "keep.md")
            .expect("read")
            .expect("present")
            .text,
        "current-4"
    );

    vt.write_text(
        &write("main", "stale.md", "newer-head", "r-stale-new", "ignored"),
        &NO_FAULTS,
    )
    .expect("mutate after conflict record");
    assert_eq!(
        vt.resolve_text_conflict(
            &resolve("resolve-5", ResolveConflictKind::ApplyIncoming, "stale"),
            &NO_FAULTS,
        )
        .expect_err("M-CONFLICT-CLOBBER head-match gate")
        .code(),
        "conflict-stale-target"
    );
}

#[test]
fn resolve_text_conflict_replays_idempotency_key_and_rejects_reuse_mismatch() {
    let (_scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(
        &write("main", "idempotent.md", "base", "idem-base", "idem-object"),
        &NO_FAULTS,
    )
    .expect("base");
    fork(&mut vt);
    vt.write_text(
        &write(
            "main",
            "idempotent.md",
            "current",
            "idem-current",
            "ignored",
        ),
        &NO_FAULTS,
    )
    .expect("current");
    vt.write_text(
        &write(
            "feat",
            "idempotent.md",
            "incoming",
            "idem-incoming",
            "ignored",
        ),
        &NO_FAULTS,
    )
    .expect("incoming");
    let current = vt
        .read_text(WS, "main", "idempotent.md")
        .expect("read current")
        .expect("current snapshot");
    let incoming = vt
        .read_text(WS, "feat", "idempotent.md")
        .expect("read incoming")
        .expect("incoming snapshot");
    drop(vt);
    let record = conflict("idempotent-resolve", "idempotent.md", current, incoming);
    store
        .write_with(&NO_FAULTS, |tx| {
            insert_text_conflict_if_absent(tx, &record)?;
            Ok::<_, DomainError>(())
        })
        .expect("insert conflict");

    let mut input = resolve(
        "idempotent-resolve",
        ResolveConflictKind::ApplyIncoming,
        "idempotent",
    );
    input.request_id = Some("resolve-request-id".to_owned());
    let first = VersionedTextStore::new(&mut store)
        .resolve_text_conflict(&input, &NO_FAULTS)
        .expect("first resolve");
    assert!(first.write.is_some());
    assert_eq!(first.conflict.status, ConflictStatus::Resolved);
    let after_first = moment_count(&store);

    let replay = VersionedTextStore::new(&mut store)
        .resolve_text_conflict(&input, &NO_FAULTS)
        .expect("idempotent replay");
    assert!(replay.write.is_none());
    assert!(replay.delete.is_none());
    assert_eq!(replay.conflict, first.conflict);
    assert_eq!(moment_count(&store), after_first);
    assert_eq!(
        VersionedTextStore::new(&mut store)
            .read_text(WS, "main", "idempotent.md")
            .expect("read resolved")
            .expect("resolved snapshot")
            .text,
        "incoming"
    );

    let mut mismatched = input.clone();
    mismatched.resolution = ResolveConflictKind::KeepCurrent;
    assert_eq!(
        VersionedTextStore::new(&mut store)
            .resolve_text_conflict(&mismatched, &NO_FAULTS)
            .expect_err("same key with different resolution must fail")
            .code(),
        "idempotency-key-reuse-mismatch"
    );
    assert_eq!(moment_count(&store), after_first);
}

#[test]
fn merge_job_crash_then_external_edit_is_preserved_on_recovery() {
    let (scratch, mut store) = open();
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(
        &write("main", "a.md", "base", "mat-base", "mat-o"),
        &NO_FAULTS,
    )
    .expect("base");
    fork(&mut vt);
    vt.write_text(
        &write("feat", "a.md", "merged-content", "mat-incoming", "ignored"),
        &NO_FAULTS,
    )
    .expect("incoming");
    vt.merge_text_file_from_version(
        &merge_input("a.md", "mat-merge", "mat-conflict", "mat-new"),
        &NO_FAULTS,
    )
    .expect("merge");
    drop(vt);

    let target = scratch.join("a.md");
    std::fs::write(&target, "base").expect("materialized preimage");
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeBeforePreimageRevalidate);
    let first = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
        600,
        faults.as_ref(),
    )
    .expect("crash run");
    assert!(matches!(first[0].outcome, JobOutcome::Crashed(_)));
    std::fs::write(&target, "external-newer").expect("external editor");

    drop(store);
    let db = scratch.engine_db_path().expect("db");
    let store = EngineStore::open(&db, 700).expect("reopen");
    let recovered = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
        800,
        &NO_FAULTS,
    )
    .expect("recover");
    assert_eq!(recovered[0].outcome, JobOutcome::Conflict);
    assert_eq!(
        std::fs::read_to_string(&target).expect("target"),
        "external-newer"
    );
    assert_eq!(
        store
            .load_materialization_job("merge-mat_mat-merge")
            .expect("job")
            .expect("present")
            .status,
        JobStatus::Conflict
    );
}

/// M2 (BINHEAD): the three-way text merge must NEVER clobber a binary head. A
/// fork forked before `a.md` existed (base absent) adds TEXT at `a.md`, while
/// the target grows a BINARY head at `a.md`. The pre-fix merge read the binary
/// head as absent (its `JOIN blobs` is binary-blind), saw current == base ==
/// absent, fast-forwarded, and overwrote the binary head with text. It must fail
/// closed instead — `binary-head-not-text` — and the binary head must survive.
#[test]
fn merge_refuses_to_clobber_a_binary_head_at_the_target() {
    let (_scratch, mut store) = open();
    // Seed an UNRELATED file on main so the fork carries a non-empty durable
    // fork base (else the merge short-circuits with `fork-base-not-found` before
    // reaching the binary-head gate). `a.md` itself does NOT exist yet, so its
    // fork base is genuinely absent.
    VersionedTextStore::new(&mut store)
        .write_text(
            &write("main", "seed.md", "seed", "seed-moment", "obj-seed"),
            &NO_FAULTS,
        )
        .expect("seed file");
    let mut vt = VersionedTextStore::new(&mut store);
    fork(&mut vt);
    drop(vt);

    // Target (main) grows a BINARY head at a.md AFTER the fork.
    let bin_bytes = b"\x00binary head\xff";
    let bin_sha = hex_sha256(bin_bytes);
    store
        .write_with(&NO_FAULTS, |tx| {
            let sha = put_binary_blob(tx, bin_bytes)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "obj-a".to_owned(),
                    path: "a.md".to_owned(),
                    binary_sha256: sha,
                    job_id: "bin-a-job".to_owned(),
                    preimage: Preimage::Absent,
                    now_ms: 120,
                },
            )?;
            Ok::<_, DomainError>(())
        })
        .expect("write binary head on main");

    // The fork adds TEXT at the same path.
    VersionedTextStore::new(&mut store)
        .write_text(
            &write("feat", "a.md", "fork text", "feat-a", "obj-feat-a"),
            &NO_FAULTS,
        )
        .expect("fork text at a.md");

    // The merge must fail closed — never clobber the binary head.
    let err = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(
            &merge_input("a.md", "merge-a", "merge-a-conflict", "obj-merge-a"),
            &NO_FAULTS,
        )
        .expect_err("merge must refuse to clobber a binary head");
    assert_eq!(err.code(), "binary-head-not-text");

    // The binary head SURVIVES on main, unchanged.
    let (kind, blob, bin): (String, Option<String>, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_kind, blob_sha256, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = 'a.md'",
                [WS],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .expect("main head after refused merge");
    assert_eq!(
        kind, "binary",
        "the binary head must survive the refused merge"
    );
    assert_eq!(blob, None, "a surviving binary head has no text blob");
    assert_eq!(bin.as_deref(), Some(bin_sha.as_str()));
}

/// S2 (BINHEAD): the exact-head gate must not defer FOREVER on a legacy binary
/// side that carries no head identity. A recorded side built via
/// `ConflictFileState::binary()` (or a v9-era row) has NULL object/latest-moment,
/// so requiring `Some(..) == None` would always mismatch and strand the resolve
/// as StaleHead. When the recorded side has NO identity, fall back to path+sha;
/// a recorded side that DOES carry identity keeps the strict no-clobber check.
#[test]
fn exact_head_gate_falls_back_for_legacy_null_identity_binary_sides() {
    let live = ConflictFileState::binary_head("a.md", "sha-bytes", "obj-live", "moment-live");

    // Legacy recorded side (NULL identity) with matching path+bytes RESOLVES.
    let legacy = ConflictFileState::binary("a.md", "sha-bytes");
    assert!(
        live_state_matches_conflict_current(&live, &legacy),
        "a legacy NULL-identity side matching path+sha must resolve, not defer forever"
    );

    // Legacy side whose bytes differ must still NOT match.
    let legacy_other = ConflictFileState::binary("a.md", "sha-other");
    assert!(
        !live_state_matches_conflict_current(&live, &legacy_other),
        "path+sha fallback must still reject a byte mismatch"
    );

    // A recorded side that DOES carry identity keeps the strict check: same
    // bytes but a recreated head (different object/moment) must NOT match.
    let strict_same =
        ConflictFileState::binary_head("a.md", "sha-bytes", "obj-live", "moment-live");
    assert!(
        live_state_matches_conflict_current(&live, &strict_same),
        "an identity-carrying side matching object+moment must still match"
    );
    let strict_recreated =
        ConflictFileState::binary_head("a.md", "sha-bytes", "obj-recreated", "moment-recreated");
    assert!(
        !live_state_matches_conflict_current(&live, &strict_recreated),
        "an identity-carrying side must reject a same-bytes-but-recreated head (no clobber)"
    );
}
