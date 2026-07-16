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
    CreateNamedVersion, NoFaults, VersionedTextStore, WriteText, store::text_blob_sha256,
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
            author_json: None,
            now_ms: 30,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("write feat");
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
    let hello = &text_blob_sha256("hello")[..12];
    let world = &text_blob_sha256("world")[..12];
    format!(
        "active=main\n\
         version id=main kind=main name=main created=1 fork_from=- fork_moment=-\n\
         version id=feat kind=named name=feature created=20 fork_from=main fork_moment=m1\n\
         snapshot version=feat path=a.md object=o1 blob={world} origin=agent\n\
         snapshot version=main path=a.md object=o1 blob={hello} origin=user\n\
         moment order=1 version=main path=a.md op=write after={hello} before_present=false sync_only=false\n\
         moment order=2 version=feat path=a.md op=write after={world} before_present=true sync_only=false\n"
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
