//! Differential harness (CAL-2 calibration signal).
//!
//! Runs a fixed operation trace against the Rust versioning engine and asserts
//! the NORMALIZED logical state — version graph, moment order, active version,
//! and snapshot blob hashes — matches a golden fixture encoding the
//! TS-documented behavior for the restore + history behaviors
//! (`versions-create-named-version`, `versions-set-active-version`,
//! `versions-list-moments`; `TEST_ORACLE.md` §2 normalizers N2/N4–N8).
//!
//! Ids that carry identity are pinned in the trace, so the capture is fully
//! deterministic and compared to a golden STRING with no ID substitution. A
//! LIVE TS-process runner would drive the same trace through the TS engine and
//! apply N7 structural ID substitution before comparing — see the PR notes.

use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, NoFaults, RenameTextFile, RollbackTextFileMutation,
    VersionedTextStore, WriteText, store::text_blob_sha256,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-diff";

/// Apply the shared trace to a freshly-opened store and return its normalized
/// canonical string.
fn run_trace(db: &std::path::Path) -> String {
    let mut store = EngineStore::open(db, 1).expect("open");
    let mut vt = VersionedTextStore::new(&mut store);

    vt.ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("main");
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            object_id: "o1".to_owned(),
            path: "a.md".to_owned(),
            text: "hello".to_owned(),
            moment_id: "m1".to_owned(),
            metadata_origin: "user".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 10,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("write main");
    vt.create_named_version(
        &CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feat".to_owned(),
            name: "feature".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("fork");
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: "feat".to_owned(),
            object_id: "o1".to_owned(),
            path: "a.md".to_owned(),
            text: "world".to_owned(),
            moment_id: "m2".to_owned(),
            metadata_origin: "agent".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 30,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("write feat");
    // Cross-version fork: fork feat2 from `main` (a NON-TIP version) while the
    // global-latest moment (m2) belongs to `feat`. feat2's fork point MUST be
    // main's latest (m1), never the global-latest m2. This exercises the fork
    // provenance the P1 bug corrupted; the fork base (frozen below) must be
    // main's content, not feat's.
    vt.create_named_version(
        &CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feat2".to_owned(),
            name: "feature2".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 25,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("cross-version fork");
    vt.rename_text_file(
        &RenameTextFile {
            workspace_id: WS.to_owned(),
            version_id: "feat".to_owned(),
            from_path: "a.md".to_owned(),
            to_path: "renamed.md".to_owned(),
            moment_id: "m3".to_owned(),
            request_id: None,
            metadata_origin: "agent".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 40,
        },
        &NO_FAULTS,
    )
    .expect("rename feat");
    vt.delete_text_file(
        &DeleteTextFile {
            workspace_id: WS.to_owned(),
            version_id: "feat".to_owned(),
            path: "renamed.md".to_owned(),
            moment_id: "m4".to_owned(),
            request_id: None,
            metadata_origin: "agent".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 50,
        },
        &NO_FAULTS,
    )
    .expect("delete feat");
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            object_id: "o1".to_owned(),
            path: "a.md".to_owned(),
            text: "temporary".to_owned(),
            moment_id: "m5".to_owned(),
            metadata_origin: "agent".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 60,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("temporary write");
    vt.rollback_text_file_mutation(
        &RollbackTextFileMutation {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: "a.md".to_owned(),
            mutation_moment_id: "m5".to_owned(),
            request_id: None,
            legacy_before_text: None,
            metadata_origin: "restore".to_owned(),
            author_json: None,
        },
        &NO_FAULTS,
    )
    .expect("rollback temporary write");
    vt.set_active_version(WS, "feat", &NO_FAULTS)
        .expect("activate feat");
    vt.set_active_version(WS, "main", &NO_FAULTS)
        .expect("restore main");

    vt.normalized_snapshot(WS)
        .expect("normalize")
        .to_canonical_string()
}

/// The golden normalized state. Blob prefixes are the first 12 hex of the
/// sha256 of the exact text bytes — the same content-by-hash the TS engine
/// records (N8). Interpolated from the domain's own hashing so the fixture is
/// self-describing and stays correct if the trace's texts change.
fn golden() -> String {
    let hello = text_blob_sha256("hello");
    let world = text_blob_sha256("world");
    format!(
        "active=main\n\
         version id=main kind=main name=Main created=1 fork_from=- fork_moment=-\n\
         version id=feat kind=named name=feature created=20 fork_from=main fork_moment=m1\n\
         version id=feat2 kind=named name=feature2 created=25 fork_from=main fork_moment=m1\n\
         snapshot version=feat2 path=a.md object=o1 content=text:{hello} origin=user\n\
         snapshot version=main path=a.md object=o1 content=text:{hello} origin=user\n\
         forkbase version=feat path=a.md object=o1 content=text:{hello}\n\
         forkbase version=feat2 path=a.md object=o1 content=text:{hello}\n\
         moment order=1 id=m1 version=main object=o1 path=a.md recorded=10 op=write after=text:{hello} before_present=false before=- before_latest=- origin=user sync_only=false\n\
         moment order=2 id=m2 version=feat object=o1 path=a.md recorded=30 op=write after=text:{world} before_present=true before=text:{hello} before_latest=m1 origin=agent sync_only=false\n\
         moment order=3 id=m3 version=feat object=o1 path=renamed.md recorded=40 op=rename after=text:{world} before_present=true before=text:{world} before_latest=m2 origin=agent sync_only=false\n\
         moment order=4 id=m4 version=feat object=o1 path=renamed.md recorded=50 op=delete after=text:{world} before_present=true before=text:{world} before_latest=m3 origin=agent sync_only=false\n"
    )
}

// oracle: the Rust engine's normalized state matches the golden fixture.
#[test]
fn restore_and_history_trace_matches_golden() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let actual = run_trace(&db);
    assert_eq!(actual, golden(), "normalized state diverged from golden");
}

// oracle: the capture is deterministic — a byte-identical replay on a fresh
// store yields the same normalized state (a differential precondition).
#[test]
fn trace_is_deterministic_across_fresh_stores() {
    let a = ScratchDir::new().expect("scratch a");
    let b = ScratchDir::new().expect("scratch b");
    let out_a = run_trace(&a.engine_db_path().expect("db a"));
    let out_b = run_trace(&b.engine_db_path().expect("db b"));
    assert_eq!(out_a, out_b);
}
